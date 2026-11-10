/**
 * @file Partition the test suite into a fast inner loop and an integration tier.
 *
 * A small minority of test files start a child process, and those files dominate
 * the suite's wall time: most of the cost is a `node dist/api.js` cold start
 * paid once per spawn, not test logic. Splitting the two lets a developer run the
 * non-spawning majority in seconds and leave the spawning files to CI. Both tier
 * sizes are one command away — `node scripts/test-partition.ts unit | wc -l` and
 * `node scripts/test-partition.ts integration | wc -l` — as is the total they add
 * up to, `git ls-files '*.test.ts' | wc -l`. Do not bake those into prose.
 *
 * CLASSIFICATION IS BY CONTENT, NOT FILENAME. Most of the spawning files do not
 * have `cli` in their name (`superset-proof-e2e-cli`, `research-workflow-*`,
 * `product-cli-apply`…), so a name glob would silently drop them into the fast
 * tier and make it a lie. The patterns below are the complete set of ways this
 * repo starts a child process, verified against every test file: `runCLI`,
 * `execFileSync`, `spawnSync`, `spawn`, `execFile`, `execSync`, `npm pack`,
 * plus `exec(...)` from a shared fixture helper.
 *
 * A file that imports a spawning fixture is integration even without a direct
 * spawn call site of its own — that is the rule recorded with the patterns below.
 *
 * WHICH DIRECTORIES ARE ENUMERATED IS A CORRECTNESS PROPERTY, NOT A CONVENIENCE.
 * The tiers are not only a developer convenience: `scripts/run-affected-tests.ts`
 * runs the unit tier verbatim when a change has suite-wide reach, so the unit
 * tier IS the escalation answer. While this walk covered `test/` alone, that
 * answer silently omitted the whole `packages/llmwiki-kg` dimension, the
 * `src/dimensions/kg` suites and `scripts/output-contracts.test.ts` — files the
 * escalation reported as covered because it never looked at them. So
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
 * `llmwiki-kg` suites, the `@repo/wiki` dimension's own suites and the
 * `dimensions/kg` ones, and `scripts` carries `output-contracts.test.ts`.
 *
 * EVERY ENTRY MUST NAME A DIRECTORY THAT EXISTS. The walk skips an absent root
 * without a word — that guard is there for a caller's `--root` on a partial
 * checkout — so a root left behind by a relocation contributes nothing and the
 * tier reports success over files it never read. `test/test-partition.test.ts`
 * pins that property by name: a root the tree does not have fails there.
 */
export const TEST_ROOTS: readonly string[] = ["test", "packages", "scripts"];

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
 *
 * The three path entries are the other half of the same rule: A SPAWN HIDDEN IN
 * A SHARED FIXTURE IS STILL A SPAWN. `run-cli-server` and `mcp-test-env`
 * fork a real subprocess on the caller's behalf, so the file
 * importing one pays that cold start without ever naming `spawn`. Reading only
 * each file's own source therefore classified every viewer and MCP stdio suite
 * as `unit` while they spawned — the fast tier was a lie for as long as this
 * list was short. Matching the import is the conservative direction on purpose:
 * a false positive costs a spawn test nothing but a slower tier, while a false
 * negative puts a spawning file back in the loop the partition exists to keep
 * fast.
 */
const SPAWN_PATTERNS: readonly RegExp[] = [
  /\brunCLI\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\bspawn\s*\(/,
  /\bexecFile\s*\(/,
  /\bexecSync\s*\(/,
  /\bnpm\s+pack\b/,
  /fixtures\/run-cli-server/,
  /fixtures\/mcp-test-env/,
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
