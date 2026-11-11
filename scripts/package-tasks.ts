/**
 * @file scripts/package-tasks.ts
 * @description Per-package task surface: run one package's `test`, `lint`,
 * `typecheck` or `fallow`, with the test set DERIVED from the import graph.
 *
 * ## Why this exists
 *
 * A workspace package could not be asked to run its own tests, because its tests
 * do not live inside it: wiki's dimension coverage sits in `test/dimensions/wiki/`,
 * compiler coverage in `test/compiler/`, and so on. The obvious fix — a per-package
 * path list — works today and rots tomorrow: someone adds
 * `test/dimensions/wiki-v2/` and the filter silently misses it with nothing
 * failing. That is the "a green that stopped looking" defect this repository has
 * spent a long time killing. So the selection is DERIVED, never enumerated.
 *
 * ## How the selection is derived
 *
 * {@link deriveSelection} asks the runner itself for the collected universe
 * (`vitest list --filesOnly --json`), crawls each collected test's transitive
 * module closure with `scripts/module-graph.ts` (vite's own graph, the same one
 * `vitest related` builds), and hands both to `scripts/package-selection.ts`,
 * whose `partition` implements the selection rule: a test belongs to package `P`
 * when its closure reaches one of `P`'s source roots, UNION when the test file
 * lives under `P`'s own directory. Both existing modules are consumed unchanged.
 *
 * It therefore cannot drift: adding a test file under any reachable directory, or
 * adding a new directory that imports a package source, changes the selection on
 * the next run without anyone editing a list here. A hand-written path list would
 * have to be edited, and nothing would fail if it was not.
 *
 * ## Exactness: the positional filters are RE-ASSERTED, never trusted
 *
 * The `test` task runs vitest under the ROOT `vitest.config.ts` — the gate's own
 * configuration, aliases included — and passes the derived files as positional
 * filters. Vitest matches a positional filter as a substring of the test path, so
 * a filter can over-match (a silent widen) just as a bad list can under-match (a
 * silent narrow). Neither is acceptable, so the run also writes vitest's JSON
 * report and {@link exactnessErrors} compares the set of FILES VITEST ACTUALLY
 * RAN against the derived set: any difference in either direction fails the task
 * with exit code 3 and every offending path named. The filters only save work;
 * the assertion is what makes the task exact.
 *
 * The alternative — a generated temp vitest config with `test.include` set to the
 * exact paths — was rejected because it would have to restate the root config's
 * aliases (`llm-wiki-compiler` -> `packages/wiki/src/index.ts` and friends) to make
 * the run behave like the gate, and a second copy of those aliases is exactly the
 * drift this slice refuses. Reusing the root config and verifying the outcome
 * keeps one definition of how a test resolves.
 *
 * `packages/llmwiki-kg/ts/vitest.config.ts` is NEVER used here. Its `include`
 * pattern only collects test files inside the package's own `src` tree, so it
 * finds 142 of the 820 test files — the narrowing recorded at
 * `odd/tasks/turborepo.md` L7(i) — and a kg run under it would be green over a
 * fifth of the suite.
 *
 * ## The other three tasks
 *
 * - `lint` reuses the house rule ratchet's own measurement and comparison
 *   (`scripts/lint-ratchet.ts` exports `collectSnapshot`, `compareViolations` and
 *   `violationKey`), because the ratchet accepts no file or scope argument: it is
 *   a whole-repo gate on a frozen baseline. The verdict here is narrowed to the
 *   package's sources plus its derived tests by filtering that measurement and
 *   taking the matching slice of the baseline. The whole-repo `pnpm run lint`
 *   remains THE gate; this is the package-scoped view of the same numbers.
 * - `typecheck` scopes to the package with a generated tsconfig extending the
 *   single root `tsconfig.json`, because no per-package tsconfig exists. The
 *   generated file is written under `node_modules/.cache/package-tasks/` and
 *   removed afterwards, and that location is load-bearing: `types` and `paths`
 *   resolve from the config file's directory, so a config outside the repository
 *   could not find `vitest/globals` at all.
 * - `@repo/kg` is special twice: its `typecheck` invokes the EXISTING ratchet
 *   `scripts/kg-typecheck.ts` (kg's typecheck surface is that ratchet, never
 *   `tsc --noEmit`, per `odd/tasks/turborepo.md` L7(iii)), and its `fallow` task
 *   re-enters the exact root `fallow:kg` script rather than restating its
 *   baseline arguments. The other three packages have no fallow baseline, so
 *   their `fallow` task states that plainly and exits 0 — inventing a surface over
 *   no baseline would be a verdict about nothing.
 *
 * ## Entry shape
 *
 * `node scripts/package-tasks.ts <test|lint|typecheck|fallow> --package <name>`.
 * The repository root comes from this file's location, never from the working
 * directory: a package script runs with the package's directory as cwd, and every
 * child here must run at the root so it sees the gate's configuration.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint } from "./cli-root.ts";
import { closeGraphServer, crawlTestClosures, createGraphServer } from "./module-graph.ts";
import {
  PACKAGE_SURFACES,
  deriveTypeOnlyDependents,
  partition,
  type PackageSurface,
  type TypeOnlyPair,
} from "./package-selection.ts";
import { runTask, type PackageTask } from "./package-tasks-runners.ts";

/** Repository root, resolved from this script's location so a package cwd cannot move it. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** One package's derived test selection, and what that selection cannot observe. */
interface Selection {
  /** Repository-relative POSIX test paths the selection runs. */
  readonly tests: string[];
  /** Type-only dependents of this package that the selection therefore cannot observe. */
  readonly typeOnly: readonly TypeOnlyPair[];
}

/** The selection for a task that derives none, so `main` has one shape to read. */
const EMPTY_SELECTION: Selection = { tests: [], typeOnly: [] };

/** Vitest's CLI entry, spawned through node so no shell or exec bit is assumed. */
const VITEST_ENTRY = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

/** The tasks a package may be asked for, in the order the usage line lists them. */
const TASKS: readonly PackageTask[] = ["test", "lint", "typecheck", "fallow"];

/** One line naming the whole CLI surface, quoted in every argument error. */
const USAGE =
  "usage: node scripts/package-tasks.ts <test|lint|typecheck|fallow> --package <@repo/name>";

/** Cap for the collected-file listing; the suite's JSON is tens of kilobytes today. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/** True when a value names one of the four task surfaces. */
function isTask(value: string): value is PackageTask {
  return (TASKS as readonly string[]).includes(value);
}

/** The task as the caller typed it, for the error message. */
function describeTaskArgument(positionals: readonly string[]): string {
  return positionals.length === 0 ? "(none)" : positionals.join(" ");
}

/** The single positional argument, or a failure naming the accepted tasks. */
function readTask(positionals: readonly string[]): PackageTask {
  const [only] = positionals;
  const candidate = positionals.length === 1 ? only : undefined;
  if (candidate !== undefined && isTask(candidate)) return candidate;
  const named = describeTaskArgument(positionals);
  throw new Error(`unknown task: ${named}; expected one of ${TASKS.join(", ")}\n${USAGE}`);
}

/** The declared surface for a package name, or a failure naming the declared ones. */
function surfaceFor(name: string | undefined): PackageSurface {
  const surface = PACKAGE_SURFACES.find((entry) => entry.name === name);
  if (surface === undefined) {
    const declared = PACKAGE_SURFACES.map((entry) => entry.name).join(", ");
    throw new Error(`unknown package: ${name ?? "(none)"}; expected one of ${declared}\n${USAGE}`);
  }
  return surface;
}

/**
 * The collected universe, repository-relative, straight from the runner.
 *
 * `vitest list --filesOnly --json` prints its report to stdout, so there is no
 * temp file to place and none to clean up. Every child here runs at the root, so
 * the collection is the gate's own collection: root config, root excludes.
 */
function collectedTestFiles(): string[] {
  const raw = execFileSync(process.execPath, [VITEST_ENTRY, "list", "--filesOnly", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_LISTING_BYTES,
  });
  const entries = JSON.parse(raw) as { file: string }[];
  return entries.map((entry) => path.relative(REPO_ROOT, entry.file).split(path.sep).join("/"));
}

/** Say on stderr what no package claims: information, not a failure of this command. */
function reportUnattributed(unattributed: readonly string[]): void {
  const named = unattributed.map((file) => `  - ${file}`).join("\n");
  process.stderr.write(
    `package-tasks: ${unattributed.length} collected test(s) belong to no package surface:\n${named}\n`,
  );
}

/**
 * True when this task must print the type-only boundary notice.
 *
 * A PURE PREDICATE so the gate is testable without executing `main`, which is private and
 * would cost a full selection derivation plus a 565-file suite run to drive. The first
 * version of this gate was a source-text filter over this file, and a staged second call
 * path walked straight through it: a filter can only recognise the shapes its author
 * thought of, while a predicate is the thing the caller has to obey.
 *
 * @param task - The task the caller asked for.
 * @returns True for `test` only: `lint`, `typecheck` and `fallow` print nothing.
 */
export function shouldReportTypeOnlyDependents(task: PackageTask): boolean {
  return task === "test";
}

/**
 * Say on stderr which tests this selection cannot fail on, and what covers them.
 *
 * A `test` selection is a closure over static import specifiers, so it cannot
 * select a test that reaches the package only through an elided `import type` —
 * that test runs in no per-package selection at all. Printing it here is the point:
 * a green from this command must not be read as a statement about those files. The
 * covering tier is the root `typecheck:tests` program; a per-package typecheck was
 * declined by the owner, so it is not an option to offer. Nothing is printed for a
 * package with no declared type-only dependents.
 *
 * An EXPORT rather than a private helper: the notice is a developer-facing contract that
 * must be pinnable without spawning the suite, and this module is the effect layer (it
 * writes a stream), so it cannot live in `package-selection.ts`, which is pure by contract
 * and decides buckets rather than printing.
 *
 * IT PRINTS FROM THE SET DERIVED AT RUN TIME, not from the committed annotation. The
 * annotation carries only `reason` text; printing it would make the notice as true as the last
 * commit rather than as true as this run, and the equality that validates it lives in a
 * `meta`-bucket test the selective path never executes.
 *
 * @param surface - The package whose test task is about to run.
 * @param dependents - The pairs derived from this run's own partition.
 */
export function reportTypeOnlyDependents(
  surface: PackageSurface,
  dependents: readonly TypeOnlyPair[],
): void {
  if (dependents.length === 0) return;
  const files = dependents.map((pair) => pair.testFile).join(", ");
  process.stderr.write(
    `package-tasks: ${surface.name} has ${dependents.length} derived type-only dependent test(s) ` +
      `this selection cannot observe (${files}); root \`typecheck:tests\` is the covering tier for that type-only edge\n`,
  );
}

/**
 * Derive one package's test selection from the import graph.
 *
 * @param surface - The package whose selection is wanted.
 * @returns Repository-relative POSIX test paths, sorted by `partition`.
 * @throws Error when the derivation selects nothing, because a task over an empty
 * selection would report success having run no test at all.
 */
async function deriveSelection(surface: PackageSurface): Promise<Selection> {
  const collected = collectedTestFiles();
  const server = await createGraphServer(REPO_ROOT);
  try {
    const closures = await crawlTestClosures(server, collected);
    const result = partition({ collected, closures });
    if (result.uncovered.length > 0) reportUnattributed(result.uncovered);
    const selected = result.packages.get(surface.name) ?? [];
    if (selected.length === 0) {
      throw new Error(
        `the derived selection for ${surface.name} is empty; ` +
          "a task over no test file would report success having run nothing",
      );
    }
    const derived = deriveTypeOnlyDependents(REPO_ROOT, { collected, result }).pairs;
    return { tests: selected, typeOnly: derived.filter((pair) => pair.packageName === surface.name) };
  } finally {
    await closeGraphServer(server);
  }
}

/**
 * Parse the CLI and run the requested task.
 *
 * `fallow` skips the derivation: a package without a baseline exits before any
 * crawl would be paid for, and `@repo/kg`'s fallow task needs no test list either.
 *
 * @param argv - Arguments after the script path.
 * @returns The task's exit status.
 */
async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { package: { type: "string" } },
    allowPositionals: true,
  });
  const task = readTask(positionals);
  const surface = surfaceFor(values.package);
  const selection = task === "fallow" ? EMPTY_SELECTION : await deriveSelection(surface);
  if (shouldReportTypeOnlyDependents(task)) reportTypeOnlyDependents(surface, selection.typeOnly);
  return runTask(task, { root: REPO_ROOT, surface, tests: selection.tests });
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
