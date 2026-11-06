/**
 * @file Pin that the affected-test tiers enumerate every test tree in the repo.
 *
 * The partition in `scripts/test-partition.ts` decides two things at once: what
 * `test:unit` runs locally, and what `scripts/run-affected-tests.ts` runs when a
 * change has suite-wide reach. A tier that silently covers only part of the
 * repository is the worst kind of failure, because it reports success for files
 * it never looked at. That is exactly what happened: the tiers walked `test/`
 * alone while `vitest run` collected three more trees.
 *
 * So this file asserts the enumeration INDEPENDENTLY of the implementation: it
 * walks the repository root with plain `fs` and requires every `*.test.ts` it
 * finds to land in exactly one tier. A new tree with tests, added by anyone,
 * fails here until the roots constant learns about it — no separate registry to
 * keep in sync, and no reliance on the very code under test to describe itself.
 *
 * The file itself must stay free of child-process call sites, so the content
 * rule classes it `unit` and it can never be skipped by the fast loop it guards.
 * Classification by content is pinned here too (one real spawning suite, one real
 * pure suite), so widening the roots cannot quietly change the rule that splits
 * the tiers.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isGlobalScope } from "../scripts/test-affected.js";
import { classifyTests, partition } from "../scripts/test-partition.js";

const ROOT = path.resolve(".");

/**
 * Directories that never hold suite files: installed packages, build output,
 * linked worktrees, tool state and the wiki cache. Descending into
 * `node_modules` alone would fabricate thousands of entries from dependencies.
 */
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".worktrees", ".claude", ".git", ".llmwiki"]);

/** The only test-file suffix this repository uses; no `.spec.ts` exists. */
const TEST_SUFFIX = ".test.ts";

const KG_PACKAGE = "packages/llmwiki-kg/";
const KG_SOURCE = "packages/llmwiki-kg/ts/src/core/ontology.ts";

/** A real suite that starts a child process, so it belongs in the slow tier. */
const SPAWNING_SUITE = "test/parity-default.test.ts";
/** A real suite with no child-process call site, so it belongs in the fast tier. */
const PURE_SUITE = "test/context-links-here.test.ts";

/** Inputs whose change reaches every file, so they must force a broad run. */
const ESCALATION_INPUTS = [
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.test.json",
  "scripts/test-partition.ts",
];

const TIERS = partition(classifyTests(ROOT));
const TIERED = [...TIERS.unit, ...TIERS.integration];

/** Recursively collect every test file under `absolute`, repo-relative and sorted. */
function walkForTests(absolute: string, found: string[] = []): string[] {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walkForTests(child, found);
    } else if (entry.name.endsWith(TEST_SUFFIX)) {
      found.push(path.relative(ROOT, child).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

describe("the tiers enumerate every test tree", () => {
  it("puts every test file an independent walk finds into a tier", () => {
    const onDisk = walkForTests(ROOT);
    const tiered = new Set(TIERED);
    const untiered = onDisk.filter((file) => !tiered.has(file));
    expect(untiered, `test files in neither tier: ${untiered.join(", ")}`).toEqual([]);
    expect(onDisk.length, "test files on disk vs files in a tier").toBe(TIERED.length);
  });

  it("puts the kg package tests in the unit tier", () => {
    const kgFiles = TIERS.unit.filter((file) => file.startsWith(KG_PACKAGE));
    expect(kgFiles.length, `kg test files per tier: ${kgFiles.join(", ")}`).toBeGreaterThan(0);
  });
});

describe("classification is still by content, not by root", () => {
  it("keeps a spawning suite in integration and a pure suite in unit", () => {
    expect(TIERS.integration).toContain(SPAWNING_SUITE);
    expect(TIERS.unit).not.toContain(SPAWNING_SUITE);
    expect(TIERS.unit).toContain(PURE_SUITE);
    expect(TIERS.integration).not.toContain(PURE_SUITE);
  });
});

describe("suite-wide inputs still escalate", () => {
  it("escalates for every global input and not for a kg source file", () => {
    const quiet = ESCALATION_INPUTS.filter((file) => !isGlobalScope(file));
    expect(quiet, `no longer escalating: ${quiet.join(", ")}`).toEqual([]);
    expect(isGlobalScope(KG_SOURCE)).toBe(false);
  });
});
