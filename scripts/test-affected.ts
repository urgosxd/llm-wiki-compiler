/**
 * @file Run only the tests a pushed change can affect.
 *
 * The full suite is CI's job: `.github/workflows/ci.yml` runs `npm test` on
 * every push and pull request, and it is the ground truth. The pre-push hook
 * used to run that same command locally, so every push paid ~9 minutes to
 * duplicate a check the push itself triggers seconds later.
 *
 * This resolves what changed since the canonical base and hands it to
 * `vitest related`, which selects only files that import the changed modules.
 * That selection is honest by construction: if an integration test imports the
 * changed code, it runs. The hook avoids IRRELEVANT work, never RELEVANT work.
 *
 * Two fallbacks protect against false negatives:
 *
 *   - A change to build/test configuration (`package.json`,
 *     `vitest.config.ts`, `tsconfig*.json`, `scripts/`) can affect any file, so
 *     it degrades to the whole `test:unit` tier rather than guessing.
 *   - When no base can be resolved (shallow clone, no upstream), it also runs
 *     the unit tier instead of silently testing nothing.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Paths whose change invalidates the scoping itself: build scripts, test
 * configuration, or dependency declarations. Touching any of them means "run the
 * tier", because the effect is global and a narrow selection would lie.
 */
const GLOBAL_SCOPE_PATHS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.test.json",
];

/** Directories whose contents are global for the same reason as {@link GLOBAL_SCOPE_PATHS}. */
const GLOBAL_SCOPE_DIRS: readonly string[] = ["scripts"];

/** Extensions worth handing to `vitest related`; anything else cannot select a test. */
const SELECTABLE_SUFFIXES: readonly string[] = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs"];

/** Outcome of resolving the pushed change set. */
export type AffectedScope =
  | { kind: "global"; reason: string }
  | { kind: "files"; files: string[] }
  | { kind: "none"; reason: string };

/** Run git and return trimmed stdout, or `null` when the command fails. */
function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical base ref, mirroring `scripts/fallow-ci.sh`: prefer
 * `upstream/main` when a fork remote exists, else `origin/main`.
 */
function resolveBaseRef(root: string): string | null {
  const remotes = git(root, ["remote"]);
  if (remotes === null) return null;
  const names = remotes.split("\n").map((line) => line.trim());
  const preferred = names.includes("upstream") ? "upstream/main" : "origin/main";
  return git(root, ["rev-parse", "--verify", "--quiet", preferred]) ? preferred : null;
}

/** True when a path's change has suite-wide reach and must force a broad run. */
export function isGlobalScope(file: string): boolean {
  if (GLOBAL_SCOPE_PATHS.includes(file)) return true;
  return GLOBAL_SCOPE_DIRS.some((dir) => file.startsWith(`${dir}/`));
}

/** Drop paths that cannot select a test, and de-duplicate while keeping order. */
export function selectableFiles(changed: readonly string[]): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const file of changed) {
    if (!SELECTABLE_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    selected.push(file);
  }
  return selected;
}

/** Parse `git diff --name-only -z` output into paths. */
function parseNameOnly(output: string): string[] {
  return output.split("\u0000").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Collect committed-plus-working-tree changes against the merge-base.
 *
 * Three sources are required because `git diff` alone misses one of them: the
 * committed range against the base, every tracked change in the working tree,
 * and UNTRACKED files. The last matters most — a new source or test file is
 * untracked until staged, `git diff --name-only HEAD` reports nothing for it, and
 * a hook that skipped it would let an entirely new test file push untested.
 */
function changedPaths(root: string, baseRef: string): string[] | null {
  const mergeBase = git(root, ["merge-base", baseRef, "HEAD"]);
  if (!mergeBase) return null;
  const committed = git(root, ["diff", "--name-only", "-z", `${mergeBase}...HEAD`]);
  const working = git(root, ["diff", "--name-only", "-z", "HEAD"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (committed === null || working === null || untracked === null) return null;
  return [
    ...parseNameOnly(committed),
    ...parseNameOnly(working),
    ...parseNameOnly(untracked),
  ];
}

/**
 * Resolve what to run for the current push.
 * @param root - Repository root.
 * @returns A global fallback, a concrete file selection, or "nothing to do".
 */
export function resolveAffectedScope(root: string): AffectedScope {
  const baseRef = resolveBaseRef(root);
  if (baseRef === null) {
    return { kind: "global", reason: "no canonical base ref (upstream/main or origin/main) could be resolved" };
  }
  const changed = changedPaths(root, baseRef);
  if (changed === null) {
    return { kind: "global", reason: `could not diff against ${baseRef}` };
  }
  if (changed.length === 0) {
    return { kind: "none", reason: `no changes since ${baseRef}` };
  }
  const global = changed.find(isGlobalScope);
  if (global !== undefined) {
    return { kind: "global", reason: `${global} affects the whole suite` };
  }
  const files = selectableFiles(changed);
  if (files.length === 0) {
    return { kind: "none", reason: "no changed file can select a test" };
  }
  return { kind: "files", files };
}

/** Resolve the repository root from `--root`, defaulting to cwd. */
function readRoot(argv: readonly string[]): string {
  const flag = argv.indexOf("--root");
  return flag === -1 ? process.cwd() : path.resolve(argv[flag + 1] ?? process.cwd());
}

/** Print the decision so the hook's log explains why it ran what it ran. */
function report(scope: AffectedScope): void {
  if (scope.kind === "global") {
    process.stderr.write(`test-affected: running the full unit tier — ${scope.reason}\n`);
  } else if (scope.kind === "none") {
    process.stderr.write(`test-affected: nothing to run — ${scope.reason}\n`);
  } else {
    process.stderr.write(`test-affected: running tests related to ${scope.files.length} changed file(s)\n`);
  }
}

/** Emit the vitest invocation for the resolved scope (empty when nothing runs). */
function main(argv: readonly string[]): void {
  const scope = resolveAffectedScope(readRoot(argv));
  report(scope);
  if (scope.kind === "global") process.stdout.write("__GLOBAL__\n");
  if (scope.kind === "files") process.stdout.write(`${scope.files.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main(process.argv.slice(2));
}
