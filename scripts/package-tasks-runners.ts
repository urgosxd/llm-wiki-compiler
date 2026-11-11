/**
 * @file scripts/package-tasks-runners.ts
 * @description The four tool invocations behind `scripts/package-tasks.ts`.
 *
 * Separated from the CLI entry because each runner has its own reason to exist and
 * its own failure modes, and keeping every one of them under the size limits
 * means one concern per file. The entry derives the selection; this module decides
 * what a `test`, `lint`, `typecheck` or `fallow` task actually executes.
 *
 * ## `test` — exact by assertion, not by hoping the filter is tight
 *
 * The selection runs under the ROOT `vitest.config.ts` with the derived files as
 * positional filters, and the same run writes vitest's JSON report, from which
 * {@link exactnessErrors} reads the set of files that ACTUALLY ran. Positional
 * filters match by substring, so they can widen silently; a list can narrow
 * silently; the report comparison catches both. Any difference — extra file, fewer
 * file, or no report at all — exits {@link EXACTNESS_EXIT_CODE} and names every
 * offending path. A generated config with `test.include` was the alternative and
 * was rejected: it would restate the root config's aliases, and a second copy of
 * how `llm-wiki-compiler` resolves is the drift this slice exists to remove.
 *
 * ## `lint` — the ratchet's own numbers, narrowed to one package
 *
 * `scripts/lint-ratchet.ts` accepts only `--update`; it has no file or scope
 * argument, and that is deliberate: it is the whole-repo gate. So the package
 * lint reuses the ratchet's measurement (`collectSnapshot`) and its comparison
 * (`compareViolations`) and narrows both to the package's files plus that
 * package's derived tests. Baselined violations stay green, new ones and stale
 * allowances fail, exactly as the gate behaves. The whole-repo `pnpm run lint`
 * remains the gate of record; this cannot replace it, because a scope narrower
 * than the tree it audits is a different measurement.
 *
 * ## `typecheck` — one root tsconfig, so the child config is generated
 *
 * There is one root `tsconfig.json` and no per-package one, so this writes a
 * tsconfig that extends it with `include` = package sources + the package's
 * derived tests, and removes it afterwards. It is written under
 * `node_modules/.cache/package-tasks/` rather than an OS temp directory because
 * `types` and `paths` resolve from the config file's own directory: a config in
 * `/tmp` cannot resolve `vitest/globals`, and restating the roots in the config
 * would duplicate the root tsconfig's alias table.
 *
 * `@repo/kg` is the exception in both directions. Its typecheck surface is the
 * existing ratchet `scripts/kg-typecheck.ts`, never `tsc --noEmit` — the weaker
 * lookalike recorded at `odd/tasks/turborepo.md` L7(iii) — and its `fallow` task
 * re-enters the root `fallow:kg` script through the resolved pnpm
 * (`scripts/pnpm-invocation.ts`) instead of restating the baseline arguments.
 *
 * ## `fallow` without a baseline is stated, not faked
 *
 * Only `@repo/kg` has `.fallowrc.json` and baselines. The other three packages
 * print one line saying so and exit 0: a fallow run over a tree with no baseline
 * would either fail on inherited debt or pass by scanning nothing, and both are
 * worse than the honest sentence.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exactnessErrors, repoRelative } from "./package-tasks-exactness.ts";
import type { PackageSurface } from "./package-selection.ts";
import {
  collectSnapshot,
  compareViolations,
  violationKey,
  type HouseViolation,
  type Snapshot,
} from "./lint-ratchet.ts";
import { resolvePnpm } from "./pnpm-invocation.ts";
import { parseRatchetBaseline } from "./ratchet-baseline.ts";

/** The four tasks a package may be asked for. */
export type PackageTask = "test" | "lint" | "typecheck" | "fallow";

/** Everything a runner needs: where the repo is, which package, and its test set. */
export interface TaskContext {
  /** Absolute repository root; every child runs here. */
  readonly root: string;
  /** The package whose surface is being run. */
  readonly surface: PackageSurface;
  /** The derived test selection; empty for `fallow`, which needs no test list. */
  readonly tests: readonly string[];
}

/** Exit code reserved for "vitest ran a different file set than the derivation named". */
const EXACTNESS_EXIT_CODE = 3;

/** The one package whose typecheck and fallow surfaces are pre-existing ratchets. */
const KG_PACKAGE = "@repo/kg";

/** The lint baseline the house-rule ratchet compares against. */
const ESLINT_BASELINE = "eslint-baseline.json";

/** File extensions the lint scope walks; the same set `eslint.config.mjs` covers. */
const CODE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** Prefix of the throwaway vitest report directory, created outside the repository. */
const REPORT_DIR_PREFIX = "package-tasks-vitest-";

/** Directory under `node_modules/.cache` that holds the generated tsconfig. */
const TSCONFIG_CACHE_DIR = path.join("node_modules", ".cache", "package-tasks");

/** Spawn a child with inherited stdio and reduce it to an exit status. */
function spawnInherit(command: string, args: readonly string[], cwd: string): number {
  const result = spawnSync(command, [...args], { cwd, env: process.env, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`package-tasks: could not start ${command} — ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/** True when an entry is a directory a scope walk should descend into. */
function isDirectory(entry: { isDirectory(): boolean }): boolean {
  return entry.isDirectory();
}

/** True when a name carries one of the extensions the lint scope covers. */
function isCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.includes(path.extname(name));
}

/** The code files directly inside one directory, repository-relative. */
function codeFilesIn(root: string, directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const here = entries
    .filter((entry) => entry.isFile() && isCodeFile(entry.name))
    .map((entry) => repoRelative(root, path.join(directory, entry.name)));
  const nested = entries
    .filter(isDirectory)
    .flatMap((entry) => codeFilesIn(root, path.join(directory, entry.name)));
  return [...here, ...nested];
}

/**
 * Every code file under a repository-relative directory, sorted.
 *
 * The walk is the package's own tree, not a hand-written list, so a new file in a
 * package source root is linted the moment it lands.
 */
function filesUnder(root: string, relativeDir: string): string[] {
  const start = path.join(root, relativeDir);
  return existsSync(start) ? codeFilesIn(root, start).sort() : [];
}

/**
 * Run the derived selection under the root vitest config and prove the run exact.
 *
 * @param context - Root, package surface and the derived test selection.
 * @returns vitest's exit status, or {@link EXACTNESS_EXIT_CODE} on an inexact run.
 */
function runTests(context: TaskContext): number {
  const reportDir = mkdtempSync(path.join(tmpdir(), REPORT_DIR_PREFIX));
  const reportPath = path.join(reportDir, "report.json");
  try {
    const status = spawnInherit(
      process.execPath,
      [
        path.join(context.root, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
        ...context.tests,
      ],
      context.root,
    );
    const problems = exactnessErrors(context.root, reportPath, context.tests);
    if (problems.length > 0) {
      process.stderr.write(`package-tasks: selection is not exact\n${problems.join("\n")}\n`);
      return EXACTNESS_EXIT_CODE;
    }
    return status;
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

/** Count violations per baseline key, so a key never borrows another's allowance. */
function countByKey(violations: readonly HouseViolation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const violation of violations) {
    const key = violationKey(violation);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** The file a baseline key names, before the rule id that follows the last space. */
function fileOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf(" "));
}

/** The slice of the stored allowances that belongs to the package's own files. */
function scopedAllowances(
  allowances: Record<string, number>,
  scope: ReadonlySet<string>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(allowances).filter(([key]) => scope.has(fileOfKey(key))));
}

/** Read the house-rule baseline through the shared, validating parser. */
function readAllowances(root: string): Record<string, number> {
  const text = readFileSync(path.join(root, ESLINT_BASELINE), "utf8");
  return parseRatchetBaseline(text, `Invalid ESLint baseline (${ESLINT_BASELINE})`).counts;
}

/** One line stating what the scoped lint measured, in the ratchet's own shape. */
function lintSummary(scope: ReadonlySet<string>, scoped: Snapshot): string {
  const files = new Set(scoped.violations.map((violation) => violation.file));
  const total = Object.values(scoped.counts).reduce((sum, count) => sum + count, 0);
  return (
    `ESLint ratchet (package scope): ${scope.size} files in scope; ` +
    `${total} baseline violations in ${files.size} files; no regression.`
  );
}

/**
 * Run the house-rule ratchet's measurement, narrowed to the package's files.
 *
 * @param context - Root, package surface and the derived test selection.
 * @returns 0 when the scoped slice matches its allowances, 1 otherwise.
 */
async function runLint(context: TaskContext): Promise<number> {
  const scope = new Set([
    ...context.surface.sourceRoots.flatMap((root) => filesUnder(context.root, root)),
    ...context.tests,
  ]);
  const measured = await collectSnapshot(context.root);
  const violations = measured.violations.filter((violation) => scope.has(violation.file));
  const scoped: Snapshot = { ...measured, violations, counts: countByKey(violations) };
  const errors = compareViolations(scoped, scopedAllowances(readAllowances(context.root), scope));
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    return 1;
  }
  console.log(lintSummary(scope, scoped));
  return 0;
}

/** The generated config: the root config, plus the package's sources and its tests. */
function generatedTsconfig(
  root: string,
  surface: PackageSurface,
  tests: readonly string[],
): Record<string, unknown> {
  return {
    extends: path.join(root, "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      allowImportingTsExtensions: true,
      rootDir: root,
      types: ["node", "vitest/globals"],
      lib: ["ES2023", "DOM", "DOM.Iterable", "DOM.AsyncIterable", "WebWorker.ImportScripts", "ScriptHost"],
    },
    include: [
      ...surface.sourceRoots.map((sourceRoot) => path.join(root, sourceRoot, "**", "*.ts")),
      ...tests.map((test) => path.join(root, test)),
    ],
  };
}

/**
 * Type-check one package without emitting, through a generated scoped tsconfig.
 *
 * @param context - Root, package surface and the derived test selection.
 * @returns tsc's exit status.
 */
function runGeneratedTypecheck(context: TaskContext): number {
  const configDir = path.join(
    context.root,
    TSCONFIG_CACHE_DIR,
    `${context.surface.name.replace(/[^a-z0-9]+/gi, "-")}-${String(process.pid)}`,
  );
  mkdirSync(configDir, { recursive: true });
  try {
    const configPath = path.join(configDir, "tsconfig.json");
    const config = generatedTsconfig(context.root, context.surface, context.tests);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const tsc = path.join(context.root, "node_modules", "typescript", "bin", "tsc");
    return spawnInherit(process.execPath, [tsc, "-p", configPath], context.root);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

/**
 * Type-check one package, through kg's ratchet when the package is `@repo/kg`.
 *
 * @param context - Root, package surface and the derived test selection.
 * @returns The checker's exit status.
 */
function runTypecheck(context: TaskContext): number {
  if (context.surface.name !== KG_PACKAGE) return runGeneratedTypecheck(context);
  const ratchet = path.join(context.root, "scripts", "kg-typecheck.ts");
  return spawnInherit(process.execPath, [ratchet], context.root);
}

/**
 * Run the package's fallow surface: kg's root script, or a stated absence.
 *
 * @param context - Root, package surface and the derived test selection.
 * @returns 0 for a package with no baseline, otherwise the fallow gate's status.
 */
function runFallow(context: TaskContext): number {
  if (context.surface.name !== KG_PACKAGE) {
    console.log(
      `no fallow surface: no baseline for ${context.surface.name}; ` +
        "the whole-repo gate is `pnpm run fallow:ci`",
    );
    return 0;
  }
  const pnpm = resolvePnpm(context.root);
  if (!pnpm.ok) {
    process.stderr.write(pnpm.message);
    return 1;
  }
  return spawnInherit(pnpm.invocation.command, [...pnpm.invocation.args, "run", "fallow:kg"], context.root);
}

/** One task's runner: synchronous for three tasks, asynchronous for `lint`. */
type TaskRunner = (context: TaskContext) => number | Promise<number>;

/** The task-to-runner table, so dispatch costs a lookup instead of a branch chain. */
const RUNNERS: Readonly<Record<PackageTask, TaskRunner>> = {
  test: runTests,
  lint: runLint,
  typecheck: runTypecheck,
  fallow: runFallow,
};

/**
 * Run one task for one package.
 *
 * @param task - The task to run.
 * @param context - Root, package surface and the derived test selection.
 * @returns The task's exit status.
 */
export async function runTask(task: PackageTask, context: TaskContext): Promise<number> {
  return RUNNERS[task](context);
}
