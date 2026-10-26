/**
 * @file test/dimensions/lint-cache-rows.test.ts
 * @description The lint cache on rows: aggregation and validation, minus the file.
 *
 * ## What moved and what did not
 *
 * `lint-cache.test.ts` mixes two subjects. Fifteen of its cases are about the FILE
 * as a storage medium: it creates `.llmwiki/`, it round-trips disk bytes, it rejects
 * a file that is not JSON, it enforces an ISO timestamp in the stored text. A row has
 * no directory to create and no text to be invalid, so those cases die with the
 * backend rather than needing a rewrite.
 *
 * The other fifteen are about what the cache MEANS: per-rule aggregation, sorting,
 * root-relative paths, severity reconciliation, and dropping a breakdown that
 * contradicts the totals it sits beside. None of that is a filesystem property, and
 * all of it would be a real hole if the row path skipped it. Those are pinned here.
 *
 * ## Why corruption is still testable
 *
 * The invariant cases need a cache whose `rules` disagree with its totals. On disk
 * that meant writing raw bytes; in a row it means storing a `findings` document that
 * contradicts its own counters. The validator runs on READ, which is where the
 * protection lives, so the corruption is constructible either way.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeLintCache, readLintCache, type LintCacheEntry } from "../../src/linter/cache.js";
import { withStackEnv } from "../fixtures/stack-env.js";
import type { LintSummary } from "../../src/linter/types.js";
import { createDimensionsDatabase } from "../../src/dimensions/activation.js";
import { writeCachedLintResult, readCachedLintResult } from "../../src/dimensions/wiki/marker-store.js";

/** A summary with the given totals but explicit per-rule results. */
function summaryOf(errors: number, warnings: number, results: LintSummary["results"]): LintSummary {
  return { errors, warnings, info: 0, results };
}

/** Provision a root plus a Stack; always tear both down. */
async function withProject(label: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await withStackEnv(label, () => body(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Store a deliberately inconsistent cache entry the way a tampered row would look. */
async function storeRawEntry(entry: LintCacheEntry): Promise<void> {
  const handle = createDimensionsDatabase(process.env);
  try {
    const stackId = (process.env["AKS_STACK_ID"] ?? "").trim();
    await writeCachedLintResult(handle.db, stackId, {
      inputHash: entry.at,
      findings: entry,
      errorCount: entry.errors,
      warningCount: entry.warnings,
    });
  } finally {
    await handle.close();
  }
}

/** Read back the raw stored document, to assert what a caller never sees. */
async function readStoredFindings(): Promise<unknown> {
  const handle = createDimensionsDatabase(process.env);
  try {
    const stackId = (process.env["AKS_STACK_ID"] ?? "").trim();
    return (await readCachedLintResult(handle.db, stackId))?.findings;
  } finally {
    await handle.close();
  }
}

describe("lint cache on rows", () => {
  it("stores the cache and creates no .llmwiki directory", () =>
    withProject("lint-nodir", async (dir) => {
      await writeLintCache(dir, summaryOf(0, 0, []));

      expect(existsSync(path.join(dir, ".llmwiki"))).toBe(false);
      expect(await readLintCache(dir)).toMatchObject({ errors: 0, warnings: 0 });
    }));

  it("returns null when the Stack has no cache yet", () =>
    withProject("lint-absent", async (dir) => {
      // A cache MISS, not an error: the caller lints again.
      expect(await readLintCache(dir)).toBeNull();
    }));

  it("counts and sorts rule rows deterministically, breaking ties by rule name", () =>
    withProject("lint-rows", async (dir) => {
      await writeLintCache(dir, summaryOf(2, 3, [
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
        { rule: "empty-page", severity: "warning", file: "c.md", message: "" },
      ]));

      const entry = await readLintCache(dir);
      expect(entry?.rules).toEqual([
        { rule: "broken-wikilink", severity: "error", count: 2, fileCount: 1, topFile: "a.md", topFileCount: 2 },
        { rule: "missing-summary", severity: "warning", count: 2, fileCount: 2, topFile: "a.md", topFileCount: 1 },
        { rule: "empty-page", severity: "warning", count: 1, fileCount: 1, topFile: "c.md", topFileCount: 1 },
      ]);
    }));

  it("reports a rule emitting both severities as an error", () =>
    withProject("lint-mixed", async (dir) => {
      await writeLintCache(dir, summaryOf(1, 1, [
        { rule: "mixed-rule", severity: "error", file: "a.md", message: "" },
        { rule: "mixed-rule", severity: "warning", file: "b.md", message: "" },
      ]));

      const entry = await readLintCache(dir);
      expect(entry?.rules?.[0]).toMatchObject({ rule: "mixed-rule", severity: "error", count: 2 });
    }));

  it("excludes info-severity findings from the rule rows", () =>
    withProject("lint-info", async (dir) => {
      await writeLintCache(dir, summaryOf(1, 0, [
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "pending-target", severity: "info", file: "a.md", message: "" },
      ]));

      const entry = await readLintCache(dir);
      expect(entry?.rules?.map((r) => r.rule)).toEqual(["broken-wikilink"]);
    }));

  it("reconciles the aggregate count with the headline totals", () =>
    withProject("lint-reconcile", async (dir) => {
      const summary = summaryOf(1, 2, [
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
        { rule: "pending-target", severity: "info", file: "a.md", message: "" },
      ]);
      await writeLintCache(dir, summary);

      const entry = await readLintCache(dir);
      expect(entry!.rules!.reduce((sum, r) => sum + r.count, 0)).toBe(summary.errors + summary.warnings);
    }));

  it("omits the rules field entirely for a clean run", () =>
    withProject("lint-clean", async (dir) => {
      await writeLintCache(dir, summaryOf(0, 0, []));

      const stored = (await readStoredFindings()) as Record<string, unknown>;
      expect("rules" in stored).toBe(false);
    }));
});

describe("lint cache row invariants", () => {
  const at = "2026-06-05T00:00:00.000Z";
  const row = { rule: "broken-wikilink", severity: "warning", count: 5, fileCount: 2, topFile: "a.md", topFileCount: 3 };

  /** Store an entry whose `rules` contradict its own counters. */
  async function withCorrupt(rules: unknown[], body: (dir: string) => Promise<void>): Promise<void> {
    await withProject("lint-corrupt", async (dir) => {
      // The counters are written to match the file format; only `rules` is wrong.
      await storeRawEntry({ warnings: 4, errors: 6, at, rules } as LintCacheEntry);
      await body(dir);
    });
  }

  it("drops rows that do not sum back to the totals, keeping the totals", () =>
    withCorrupt([{ ...row, count: 65 }], async (dir) => {
      const entry = await readLintCache(dir);
      expect(entry?.rules).toBeUndefined();
      expect(entry).toMatchObject({ warnings: 4, errors: 6, at });
    }));

  it("drops rows whose worst file carries more findings than the rule produced", () =>
    withCorrupt([{ ...row, topFileCount: 99 }], async (dir) => {
      expect((await readLintCache(dir))?.rules).toBeUndefined();
    }));

  it("drops rows flagging more distinct files than the rule has findings", () =>
    withCorrupt([{ ...row, fileCount: 9 }], async (dir) => {
      expect((await readLintCache(dir))?.rules).toBeUndefined();
    }));

  it("keeps a breakdown that reconciles with the totals", () =>
    withCorrupt([{ ...row, count: 10, fileCount: 2, topFileCount: 3 }], async (dir) => {
      // 6 errors + 4 warnings = 10, and the row has count 10 with parts under it, so
      // this one is honest and must survive. A validator that dropped it would be
      // throwing away a correct breakdown, which is the failure mode the partial
      // drop exists to avoid.
      const entry = await readLintCache(dir);
      expect(entry?.rules).toEqual([{ ...row, count: 10, fileCount: 2, topFileCount: 3 }]);
    }));
});
