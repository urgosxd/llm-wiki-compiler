/**
 * @file Partition the test suite into a fast inner loop and an integration tier.
 *
 * Measured on the full suite: 131 files contain a spawn call site and consume
 * 54% of all file-time at an average of 13.7s each, while the other 1180 files
 * average 1.3s. The cost is `node dist/cli.js` cold start (~1.5s) repeated 544
 * times, not test logic. Splitting the two lets a developer run the 1180 cheap
 * files in seconds and leave the expensive ones to CI.
 *
 * CLASSIFICATION IS BY CONTENT, NOT FILENAME. 75 of the 131 spawning files do
 * not have `cli` in their name (`superset-proof-e2e-cli`, `research-workflow-*`,
 * `product-cli-apply`…), so a name glob would silently drop them into the fast
 * tier and make it a lie. The patterns below are the complete set of ways this
 * repo starts a child process, verified against every test file:
 * `runCLI(...)` (542 sites), `execFileSync` (32), `spawnSync` (13), `spawn` (5),
 * `execFile` (2), `npm pack` (6 files), plus `exec(...)` from the shared
 * `fixtures/cli-runner` helper.
 *
 * A file that imports `cli-runner` is integration even without a direct spawn
 * call site of its own — the helper exists precisely to spawn the built CLI, and
 * three files (`cli.test.ts`, `claim-provenance-integration`, `rm-cli`) call
 * `exec(...)` through it rather than naming a child-process API.
 *
 * WHICH DIRECTORIES ARE ENUMERATED IS A CORRECTNESS PROPERTY, NOT A CONVENIENCE.
 * The tiers are not only a developer convenience: `scripts/run-affected-tests.ts`
 * runs the unit tier verbatim when a change has suite-wide reach, so the unit
 * tier IS the escalation answer. While this walk covered `test/` alone, that
 * answer silently omitted the whole `packages/llmwiki-kg` dimension (86 files),
 * the three `src/dimensions/kg` suites and `scripts/output-contracts.test.ts` —
 * files the escalation reported as covered because it never looked at them. So
 * {@link TEST_ROOTS} is an explicit, named list of every directory `vitest run`
 * collects from, and the default enumeration is exhaustive over it. Widening is
 * safe precisely because classification stays by content: a new root brings
 * files in as `unit` unless they actually spawn. A tree that appears without
 * being added to this list fails `test/test-partition-coverage.test.ts`, which
 * walks the repository independently instead of trusting this file.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isEntryPoint, readRoot } from "./cli-root.ts";

/** Marker appended to a vitest `--exclude` so shell quoting stays predictable. */
const TEST_SUFFIX = ".test.ts";

/**
 * Every directory that can hold suite files, relative to the repository root.
 *
 * Must stay a superset of what `vitest run` collects, because a file missing
 * from here is missing from the escalation tier too. `packages` carries the
 * `llmwiki-kg` dimension, `src` carries the root dimension's own suites, and
 * `scripts` carries `output-contracts.test.ts`.
 */
export const TEST_ROOTS: readonly string[] = ["test", "packages", "src", "scripts"];

/**
 * Directory names the walk never descends into. `node_modules` is mandatory:
 * `packages/llmwiki-kg` has its own installed tree, and descending into it would
 * fabricate thousands of paths from dependencies. `dist` would pick up emitted
 * copies of sources, and the dotted entries are linked worktrees and tool state.
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".worktrees",
  ".claude",
  ".git",
  ".llmwiki",
]);

/**
 * Every construct in this repo that starts a child process, or that goes
 * through the shared helper which does. Deliberately narrow: matching the bare
 * word `exec` would also catch `regex.exec`, and `spawn` alone would match the
 * prose in comments.
 */
const SPAWN_PATTERNS: readonly RegExp[] = [
  /\brunCLI\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\bspawn\s*\(/,
  /\bexecFile\s*\(/,
  /\bexecSync\s*\(/,
  /\bnpm\s+pack\b/,
  /fixtures\/cli-runner/,
];

/** One classified test file. */
export interface ClassifiedTest {
  /** Repository-relative POSIX path, e.g. `test/context-integration.test.ts`. */
  file: string;
  /** True when the file starts a child process (or uses the helper that does). */
  spawns: boolean;
}

/**
 * Recursively collect every `*.test.ts` under {@link TEST_ROOTS}.
 *
 * Deliberately NOT exported and deliberately root-less: an internal walk that a
 * caller could aim at one subtree is the same footgun as a `dir` parameter, just
 * one indirection further away.
 *
 * @param root - Repository root.
 * @returns Sorted, de-duplicated repo-relative POSIX paths.
 */
function collectTestFiles(root: string): string[] {
  const found = new Set<string>();
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(child);
      } else if (entry.name.endsWith(TEST_SUFFIX)) {
        found.add(path.relative(root, child).split(path.sep).join("/"));
      }
    }
  };
  for (const dir of TEST_ROOTS) {
    const absolute = path.join(root, dir);
    if (existsSync(absolute)) walk(absolute);
  }
  return [...found].sort();
}

/** True when the file's source contains any child-process construct. */
export function spawnsChildProcess(source: string): boolean {
  return SPAWN_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * Classify every test file in the suite.
 *
 * THIS IS THE ONLY WAY IN, and it takes no root selector on purpose. The
 * escalation tier is built from exactly this call, so a parameter — even an
 * optional one defaulting to the full {@link TEST_ROOTS} — would let a caller
 * narrow the enumeration by omission and reintroduce the blind spot with a
 * passing suite. Classification stays by content; only the reach is fixed.
 *
 * @param root - Repository root.
 * @returns One entry per test file, sorted by path.
 */
export function classifyTests(root: string): ClassifiedTest[] {
  return collectTestFiles(root).map((file) => ({
    file,
    spawns: spawnsChildProcess(readFileSync(path.join(root, file), "utf8")),
  }));
}

/** The two tiers the suite splits into. */
export interface TestPartition {
  /** Files that never start a child process: the fast inner loop. */
  unit: string[];
  /** Files that start a child process: the slow integration tier. */
  integration: string[];
}

/** Split classified files into the two tiers, preserving sorted order. */
export function partition(classified: readonly ClassifiedTest[]): TestPartition {
  const unit: string[] = [];
  const integration: string[] = [];
  for (const entry of classified) {
    (entry.spawns ? integration : unit).push(entry.file);
  }
  return { unit, integration };
}

/** Print the tier named by `argv` (`unit` or `integration`) one path per line. */
function main(argv: readonly string[]): void {
  const tier = argv[1];
  if (tier !== "unit" && tier !== "integration") {
    process.stderr.write("usage: test-partition.ts <unit|integration> [--root DIR]\n");
    process.exitCode = 2;
    return;
  }
  // `argv` here is already sliced past the node/script pair by the entry guard,
  // and `readRoot` scans the whole list it is given for `--root`.
  const files = partition(classifyTests(readRoot(argv)))[tier];
  process.stdout.write(files.length > 0 ? `${files.join("\n")}\n` : "");
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(1));
}
