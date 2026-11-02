/**
 * @file test/lint-row-corpus.test.ts
 * @description A lint run against a Stack's pages must judge those pages.
 *
 * WHY THIS EXISTS
 *
 * Every rule read pages through `collectAllPages`, which walks `wiki/concepts` and
 * `wiki/queries`. A Stack-backed project has neither, so the linter walked an empty
 * tree and answered "nothing is wrong" — for a corpus it never read. Measured: a
 * root with no `wiki/` returns `{errors: 0, warnings: 0}`; the same corpus
 * materialized on disk returns findings.
 *
 * The corpus now travels in an async scope, so rules keep their signatures. These
 * tests pin the two halves that can each fail silently: the row corpus is what the
 * rules see, and the disk path is untouched when no Stack is configured.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { lint } from "../src/linter/index.js";
import {
  lintRowCorpus,
  rawPage,
  stackProjectRoot,
  writeDiskPage,
} from "./fixtures/lint-row-corpus.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("lint against a row corpus", () => {
  it("reports findings from the rows instead of a clean verdict on an unread tree", async () => {
    dir = await stackProjectRoot("rows");
    const report = await lintRowCorpus(dir, [
      // Empty bodies: `checkEmptyPages` fires. Summaries present so only one rule
      // is in play at a time.
      rawPage("empty-one", { title: "Empty One", summary: "s" }, ""),
      rawPage("empty-two", { title: "Empty Two", summary: "s" }, "   "),
    ]);

    expect(report.deterministic.length + report.providerJudgement.length).toBeGreaterThan(0);
  });

  it("reports nothing when the row corpus is genuinely clean", async () => {
    dir = await stackProjectRoot("rows-clean");
    const report = await lintRowCorpus(dir, [
      rawPage("fine", { title: "Fine Page", summary: "A summary." }),
    ]);

    // The point is not "always find something" — it is that the verdict is about
    // the pages that exist, not about a directory that does not.
    expect(report.deterministicErrors).toBe(0);
  });

  it("reconstructs frontmatter so metadata rules still see their fields", async () => {
    dir = await stackProjectRoot("rows-orphan");
    const report = await lintRowCorpus(dir, [
      rawPage("orphaned-page", { title: "Orphaned", summary: "s", orphaned: true }),
    ]);

    // `orphaned` is a stored column, so it survives the round trip and the rule that
    // reads frontmatter sees it. A page served as bare body would parse as having no
    // metadata, and this rule would silently never fire.
    expect(report.deterministic.length + report.derivedView.length).toBeGreaterThan(0);
  });
});

describe("lint with no Stack configured", () => {
  it("still walks disk when no row corpus is supplied", async () => {
    dir = await stackProjectRoot("disk");
    await writeDiskPage(dir, "empty", "---\ntitle: Empty\nsummary: s\n---\n\n");
    // No seams mocked: the real ones yield undefined without a Stack.

    const summary = await lint(dir);

    expect(summary.errors + summary.warnings).toBeGreaterThan(0);
  });
});
