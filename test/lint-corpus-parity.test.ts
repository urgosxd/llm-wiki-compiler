/**
 * @file test/lint-corpus-parity.test.ts
 * @description What a row corpus CAN and CANNOT answer, pinned in one place.
 *
 * WHY THIS EXISTS
 *
 * Making the linter read rows is not enough for parity, and pretending otherwise
 * would be dishonest. `wiki.pages` stores pages whose frontmatter was stripped on
 * the way in, and it has no column for `confidence`, `contradictedBy`,
 * `provenanceState` or `promptModifiers`. Those fields are dropped AT WRITE TIME,
 * so the rules that depend on them are vacuous on a Stack — no change to the
 * reader can recover them.
 *
 * That is a schema defect, not a lint defect, and it is a separate feature. What
 * this test does is make the gap explicit and machine-checked: the excluded set is
 * named once, and a rule that silently joins or leaves it fails here instead of
 * quietly reporting "clean" for evidence nobody stored.
 *
 * ## Why the exclusions are asserted by behaviour, not by declaration
 *
 * A list of rule names in a file proves nothing. Each case below builds the row
 * page that WOULD trigger the rule if its field survived, and asserts the verdict
 * — so the day the schema grows a column, the test that should start failing is
 * the one that says "unavailable".
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import * as seam from "../src/dimensions/wiki/page-source-seam.js";
import {
  METADATA_NOT_STORED_IN_ROWS,
  RULES_UNAVAILABLE_ON_ROWS,
} from "../src/linter/corpus.js";
import { lintByTier } from "../src/linter/index.js";
import type { RawWikiPage } from "../src/wiki/collect.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A clean page body long enough to pass the empty-body rule. */
const REAL_BODY = "A body with enough prose to satisfy the empty-page check comfortably.";

/** One concept page as a row returns it. */
function rawPage(slug: string, fields: Record<string, unknown>): RawWikiPage {
  return {
    slug,
    pageDirectory: "concepts",
    filePath: `/virtual/wiki/concepts/${slug}.md`,
    title: typeof fields.title === "string" ? fields.title : slug,
    frontmatter: fields,
    body: REAL_BODY,
    parseStatus: {
      hasFrontmatterBlock: true,
      malformedFrontmatter: false,
      hasTitle: true,
      orphaned: false,
    },
  };
}

/** Lint the given pages as a Stack corpus, under a fresh project root. */
async function lintRows(pages: RawWikiPage[]) {
  dir = await mkdtemp(path.join(tmpdir(), "lint-parity-"));
  await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
  vi.spyOn(seam, "withRawPageSource").mockImplementation(
    async (_root, _env, fn) => await fn({ collect: async () => pages }),
  );
  return await lintByTier(dir);
}

/** Every rule id the tiered report mentions, across all three tiers. */
function ruleIds(report: Awaited<ReturnType<typeof lintByTier>>): string[] {
  return [...report.deterministic, ...report.providerJudgement, ...report.derivedView]
    .map((result) => result.rule);
}

describe("row corpus: the metadata a Stack cannot store", () => {
  it("names the fields the write path drops", () => {
    // If a column is added, this assertion is the tripwire: the field leaves the
    // list and the rule below must start reporting.
    expect([...METADATA_NOT_STORED_IN_ROWS]).toEqual([
      "confidence",
      "contradictedBy",
      "provenanceState",
      "promptModifiers",
    ]);
  });

  it("names the rules that cannot be answered from rows", () => {
    expect([...RULES_UNAVAILABLE_ON_ROWS]).toContain("low-confidence");
    expect([...RULES_UNAVAILABLE_ON_ROWS]).toContain("contradicted-page");
  });

  it("cannot report low confidence from a row corpus (the field was never stored)", async () => {
    // A page that a FILE with `confidence: 0.1` would flag. The row source cannot
    // carry the field, so the rule stays silent -- documented, not hidden.
    const report = await lintRows([rawPage("faint", { title: "Faint", summary: "s" })]);
    expect(ruleIds(report)).not.toContain("low-confidence");
  });

  it("still answers every rule whose inputs a row DOES carry", async () => {
    // `summary` IS a column. A page without one must still be reported, proving the
    // corpus is genuinely read rather than every rule silently going quiet.
    const report = await lintRows([rawPage("bare", { title: "Bare" })]);
    expect(ruleIds(report)).toContain("missing-summary");
  });
});
