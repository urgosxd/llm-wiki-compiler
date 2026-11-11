/**
 * @file Regression guard for the derived test selection built on vite's module graph.
 *
 * `scripts/module-graph.ts` answers one question — "which collected test files
 * reach this source file?" — because `vitest related` can print that selection but
 * cannot return it as data (vitest 3.2.7 has no enumeration mode). The crawl is
 * therefore a second resolver standing next to `related`, and the only thing that
 * keeps it honest is parity against the real one. That parity is frozen here as two
 * literal arrays produced by `vitest related` at commit
 * a12fd91f1fe850e77b46a0698cec29ae22e188fa: 6 files for
 * `packages/wiki/src/index.ts`, and 23 for that file plus
 * `packages/wiki/src/sdk/compiler-composition.ts`.
 *
 * WHY THE ORACLE IS FROZEN AND NOT CALLED LIVE. Comparing two resolvers inside one
 * test would let a shared misreading of the graph pass on both sides. The oracle
 * has to sit where a change to the crawler cannot reach it.
 *
 * THE DEPTH CONTRAST IS LOAD-BEARING. `transformRequest` records only a module's
 * own imports, so a single pass yields depth-1 closures and stops. The pair of
 * inputs selects 23 files while the single input selects 6; a regression back to
 * one pass cannot reach that second number, which is what the strictly-greater
 * assertion below pins. The 30 s ceiling catches the other and worse regression:
 * a crawl switched to `ssrLoadModule`, which executes code, instead of
 * `transformRequest`, which does not.
 *
 * This file spawns `vitest list` to learn the collected universe, and it calls
 * `execFileSync` literally on purpose: `scripts/test-partition.ts` classifies a test
 * by its content, so this file earns the integration tier from its own evidence
 * rather than from a filename convention.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeGraphServer,
  crawlTestClosures,
  createGraphServer,
  relatedTests,
  type GraphServer,
} from "../scripts/module-graph.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/** A crawl that takes longer than this is executing code, not parsing it. */
const CRAWL_BUDGET_MS = 30_000;

/** Oracle input one, and the exactly-6 selection `vitest related` returned for it. */
const SINGLE_SOURCES: readonly string[] = ["packages/wiki/src/index.ts"];
const SINGLE_TESTS: readonly string[] = [
  "test/offline-provider-keyless.test.ts",
  "test/okf-sdk.test.ts",
  "test/parity-default.test.ts",
  "test/query-answer-citations-recovery.test.ts",
  "test/query-answer-citations.test.ts",
  "test/query-publication-sdk-mcp.test.ts",
];

/** Oracle input two, and the exactly-23 selection `vitest related` returned for it. */
const PAIR_SOURCES: readonly string[] = [
  "packages/wiki/src/index.ts",
  "packages/wiki/src/sdk/compiler-composition.ts",
];
const PAIR_TESTS: readonly string[] = [
  "test/artifact/entries-load.test.ts",
  "test/compile-options.test.ts",
  "test/compiler/graph-retirement-port-absence.test.ts",
  "test/offline-provider-keyless.test.ts",
  "test/okf-sdk.test.ts",
  "test/parity-default.test.ts",
  "test/query-answer-citations-recovery.test.ts",
  "test/query-answer-citations.test.ts",
  "test/query-publication-sdk-mcp.test.ts",
  "test/review-option-removal-entries.test.ts",
  "test/sdk/acceptance.test.ts",
  "test/sdk/core-composition.test.ts",
  "test/sdk/create-wiki-root.test.ts",
  "test/sdk/facade-env-threading.test.ts",
  "test/sdk/facade-lint-unreachable-db.test.ts",
  "test/sdk/facade.test.ts",
  "test/sdk/ingest-dimensions-port.test.ts",
  "test/sdk/ingest-journal.test.ts",
  "test/sdk/ingest-request-env.test.ts",
  "test/sdk/source-api.test.ts",
  "test/sdk/surface.test.ts",
  "test/status/sources-count-matches-selection.test.ts",
  "test/system-policy-invalidation.test.ts",
];

let server: GraphServer;
let closures: Map<string, Set<string>>;
let collected: string[];
let repoRelativeCollected: Set<string>;
let crawlMs = 0;

/**
 * Ask the runner itself which files it collects.
 *
 * The universe must come from `vitest`, never from a glob: the crawl has to answer
 * for exactly the files a real run would execute, including whatever `vitest.config.ts`
 * excludes and whatever `test:pack` keeps out of collection.
 */
function collectedTestFiles(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "module-graph-list-"));
  const report = join(dir, "collected.json");
  try {
    execFileSync("corepack", ["pnpm", "exec", "vitest", "list", "--filesOnly", `--json=${report}`], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "pipe",
    });
    const entries = JSON.parse(readFileSync(report, "utf8")) as { file: string }[];
    return entries.map((entry) => entry.file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Repo-relative POSIX form of an absolute collected path. */
function repoRelative(absolute: string): string {
  return absolute.slice(REPO_ROOT.length + 1).split("\\").join("/");
}

beforeAll(async () => {
  collected = collectedTestFiles();
  repoRelativeCollected = new Set(collected.map(repoRelative));
  server = await createGraphServer(REPO_ROOT);
  const startedAt = performance.now();
  closures = await crawlTestClosures(server, collected);
  crawlMs = performance.now() - startedAt;
}, 180_000);

afterAll(async () => {
  await closeGraphServer(server);
});

it("crawls every collected test file, keyed by repo-relative POSIX path", () => {
  expect(closures.size).toBe(collected.length);
  const unkeyed = [...repoRelativeCollected].filter((file) => !closures.has(file));
  expect(unkeyed).toEqual([]);
});

it("reproduces vitest related for a single wiki source", () => {
  expect(relatedTests(closures, SINGLE_SOURCES)).toEqual([...SINGLE_TESTS]);
});

it("reproduces vitest related for the wiki source pair", () => {
  expect(relatedTests(closures, PAIR_SOURCES)).toEqual([...PAIR_TESTS]);
});

it("returns only paths that are collected test files on disk", () => {
  const selected = [...relatedTests(closures, SINGLE_SOURCES), ...relatedTests(closures, PAIR_SOURCES)];
  expect(selected.filter((file) => !file.endsWith(".test.ts"))).toEqual([]);
  expect(selected.filter((file) => !existsSync(join(REPO_ROOT, file)))).toEqual([]);
  expect(selected.filter((file) => !repoRelativeCollected.has(file))).toEqual([]);
});

it("proves the fixed point is load-bearing: the pair selects strictly more than the single source", () => {
  expect(SINGLE_SOURCES.length).toBe(1);
  expect(PAIR_TESTS.length).toBeGreaterThan(SINGLE_TESTS.length);
  const single = relatedTests(closures, SINGLE_SOURCES);
  const pair = relatedTests(closures, PAIR_SOURCES);
  expect(pair.length).toBeGreaterThan(single.length);
  expect(single.every((file) => pair.includes(file))).toBe(true);
});

it("completes the crawl well inside the execution-free budget", () => {
  expect(crawlMs).toBeGreaterThan(0);
  expect(crawlMs).toBeLessThan(CRAWL_BUDGET_MS);
});
