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
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isEntryPoint, readRoot } from "./cli-root.ts";

/** Default directory holding the suite, relative to the repository root. */
export const TEST_DIR = "test";

/** Marker appended to a vitest `--exclude` so shell quoting stays predictable. */
const TEST_SUFFIX = ".test.ts";

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

/** Recursively collect every `*.test.ts` under `dir`, as repo-relative POSIX paths. */
function collectTestFiles(root: string, dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        // `node_modules` never holds suite files; skipping it keeps the walk bounded.
        if (entry.name !== "node_modules") walk(child);
      } else if (entry.name.endsWith(TEST_SUFFIX)) {
        found.push(path.relative(root, child).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(root, dir));
  return found.sort();
}

/** True when the file's source contains any child-process construct. */
export function spawnsChildProcess(source: string): boolean {
  return SPAWN_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * Classify every test file in the suite.
 *
 * @param root - Repository root.
 * @param dir - Suite directory relative to `root` (default {@link TEST_DIR}).
 * @returns One entry per test file, sorted by path.
 */
export function classifyTests(root: string, dir: string = TEST_DIR): ClassifiedTest[] {
  return collectTestFiles(root, dir).map((file) => ({
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
