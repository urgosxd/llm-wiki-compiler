/**
 * @file test/dimensions/store-parity.test.ts
 * @description THE ACCEPTANCE TEST (S7): one corpus, ingested through the file-backed
 * store and through the row-backed store, must produce equivalent OBSERVABLE output for
 * all four artifacts -- aliases, curated links with anchors, categories with membership
 * evidence, and attribution gaps.
 *
 * ## What "equivalent" means here, and what it does not
 *
 * It does not mean byte-identical storage: a row is not a file. It means that everything
 * a reader can observe through the public interface agrees. For each artifact this suite
 * therefore compares the surface a user actually touches:
 *
 *  - the ALIAS SET a page carries, read as page content (frontmatter, as the reader
 *    receives it) -- plus the identity FOLD, i.e. that the same names landed on the same
 *    canonical page and the folded spelling got none of its own;
 *  - the curated-link RECORDS field for field (`stableKey`, both page ids, the anchor's
 *    text and both prose sides, the provenance), the rendered BODIES, and the DROP report
 *    the run prints when an anchor is gone. Anchor fields are compared EXACTLY: the
 *    whitespace-trim workaround that used to hide a renderer defect is gone (`L7`), so an
 *    extra byte in those windows is a regression and has to fail;
 *  - the CATEGORY (identity, canonical name, description, inclusion criterion) and every
 *    membership's `pageId`/`reason`/`evidenceKey`, plus the run's acceptance and refusal
 *    counts;
 *  - the attribution GAP: the marked page and the missing source it is marked for, the
 *    COUNT and the NAMES in the run output, and a fully attributed page that reports no
 *    gap in either path.
 *
 * ## Anti-vacuity
 *
 * Comparing empty to empty is a failed test, not a pass, so every comparison asserts that
 * BOTH sides are non-empty first, and at least one concrete case per artifact is pinned to
 * an explicit expected value rather than to whatever the other backend said. That matters
 * because `--recompile` writes no categories at all (`L8`): a parity case built on a
 * scoped regeneration would compare nothing to nothing. Every run here is a FULL compile.
 *
 * ## One run, four assertions
 *
 * The corpus is expensive (four compiles per backend, on a real Stack, with the real
 * document store) and the four artifacts interfere with each other, so it is replayed ONCE
 * in `beforeAll` and each case reads a different slice of the same evidence. Replaying it
 * per case would also let the four cases measure four different corpora, which is the
 * failure mode this suite exists to prevent.
 *
 * Every compile goes through `compileAndReport` -- the pipeline a user runs -- never
 * through an exported stage called by hand: a store that works only when a test calls it
 * directly proves nothing about integration (S8).
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProbeStack } from "./harness-lifecycle.js";
import { parityRoots, withoutStack } from "../fixtures/category-rows.js";
import { CATEGORY_CRITERION, CATEGORY_DESCRIPTION, CATEGORY_REASON, SISTEMAS_TITLE } from "../fixtures/category-scenario.js";
import {
  CONSENSO_FILE,
  DROP_LINE,
  DROP_SUMMARY,
  GAP_LINE,
  LINK,
  SISTEMAS_SLUG,
  TARGET_ALIAS,
  TARGET_SLUG,
  TARGET_TITLE,
  runParityCorpus,
  type ParityEvidence,
} from "../fixtures/store-parity-corpus.js";

/** The anchor's prose sides, pinned byte for byte from the corpus body. */
const ANCHOR_BEFORE = `\nDistribuidos: consenso distribuido, vectores en un `;
const ANCHOR_AFTER = `. ^[sistemas.md:1-1]\n`;

/** Probe before declaring the cases, so a machine without Postgres skips instead of failing. */
const probe = await createProbeStack("store-parity");

describe.skipIf(!probe.harness.reachable)("file-backed and row-backed wikis behave identically", () => {
  let files: ParityEvidence;
  let rows: ParityEvidence;
  let projectRoot = "";
  let saved: NodeJS.ProcessEnv = { ...process.env };

  beforeAll(async () => {
    saved = { ...process.env };
    const root = await mkdtemp(path.join(os.tmpdir(), "store-parity-"));
    projectRoot = root;
    const { filesRoot, rowsRoot } = await parityRoots(root);
    // The file-backed half runs with NO Stack, so every seam resolves to the on-disk
    // backend; the row-backed half runs with the probe's Stack installed.
    files = await withoutStack(() => runParityCorpus(filesRoot));
    Object.assign(process.env, probe.env());
    rows = await runParityCorpus(rowsRoot, probe.harness);
  });

  afterAll(async () => {
    process.env = saved;
    vi.restoreAllMocks();
    // The temp root holds two real compiles' worth of page files; it is this suite's to
    // remove, and leaving it behind is how a test run silently fills the host's /tmp.
    await rm(projectRoot, { recursive: true, force: true });
    await probe.harness.cleanup();
  });

  it("carries the same aliases, folded onto the same page, in both backends", () => {
    // ANTI-VACUITY: both sides must have folded something before they are compared.
    expect(files.targetAliases.length).toBeGreaterThan(0);
    expect(rows.targetAliases.length).toBeGreaterThan(0);
    expect(rows.targetAliases).toEqual(files.targetAliases);
    expect(rows.targetAliases).toContain(TARGET_ALIAS);
    // The FOLD: one page under one canonical title, and no page for the folded spelling.
    expect(rows.targetTitle).toBe(TARGET_TITLE);
    expect(files.targetTitle).toBe(TARGET_TITLE);
    expect(rows.foldedPageExists).toBe(false);
    expect(files.foldedPageExists).toBe(false);
    expect(rows.conceptSlugs).toEqual(files.conceptSlugs);
    expect(rows.conceptSlugs).toEqual([SISTEMAS_SLUG, TARGET_SLUG]);
  });

  it("keeps the same curated record, every anchor field included", () => {
    expect(files.curatedRecords.length).toBeGreaterThan(0);
    expect(rows.curatedRecords.length).toBeGreaterThan(0);
    expect(rows.curatedRecords).toEqual(files.curatedRecords);
    // One concrete case, pinned rather than taken from the other backend.
    expect(rows.curatedRecords).toHaveLength(1);
    const [record] = rows.curatedRecords;
    expect({
      source: record.sourcePageId,
      target: record.targetPageId,
      provenance: record.provenance,
      text: record.anchor.text,
      before: record.anchor.before,
      after: record.anchor.after,
    }).toEqual({
      source: `concepts/${SISTEMAS_SLUG}`,
      target: `concepts/${TARGET_SLUG}`,
      provenance: "model-verdict",
      text: TARGET_ALIAS,
      before: ANCHOR_BEFORE,
      after: ANCHOR_AFTER,
    });
    expect(record.stableKey).toHaveLength(16);
  });

  it("restores the link into the same body a reader receives", () => {
    // The page was REGENERATED by the restore run, so the link can only be there if the
    // record was read back and re-anchored -- which makes this a read-back, not an echo.
    expect(files.restoredBody).toContain(LINK);
    expect(rows.restoredBody).toContain(LINK);
    expect(rows.restoredBody).toBe(files.restoredBody);
  });

  it("drops the record and reports it the same way when the anchor is gone", () => {
    expect(files.dropReport.length).toBeGreaterThan(0);
    expect(rows.dropReport.length).toBeGreaterThan(0);
    expect(rows.dropReport).toBe(files.dropReport);
    expect(rows.dropReport).toContain(DROP_LINE);
    expect(rows.dropReport).toContain(DROP_SUMMARY);
    // The link is gone from the page AND the record is forgotten, so no later run
    // re-reports a link that no prose supports.
    expect(rows.bodyAfterDrop).not.toContain(LINK);
    expect(rows.bodyAfterDrop).toBe(files.bodyAfterDrop);
    expect(rows.recordsAfterDrop).toBe(0);
  });

  it("stores the same category with the same membership evidence", () => {
    expect(files.category).toBeDefined();
    expect(rows.category).toBeDefined();
    expect(rows.category).toEqual(files.category);
    const category = rows.category;
    if (category === undefined) throw new Error("the row backend stored no category");
    expect(category.categoryId).toBe(SISTEMAS_SLUG);
    expect(category.canonicalName).toBe(SISTEMAS_TITLE);
    expect(category.description).toBe(CATEGORY_DESCRIPTION);
    expect(category.inclusionCriterion).toBe(CATEGORY_CRITERION);
    expect(category.members.length).toBeGreaterThan(0);
    const [member] = category.members;
    expect(member.pageId).toBe(`concepts/${SISTEMAS_SLUG}`);
    expect(member.reason).toBe(CATEGORY_REASON);
    expect(member.evidenceKey).toBe("consenso-distribuido");
    // The table holds what the port read, so the port is not reading its own write.
    expect(rows.categoryRowCount).toBe(1);
    expect(rows.memberRowCount).toBe(1);
  });

  it("marks, counts and names the same attribution gap, and clears a full page", () => {
    expect(files.markedGaps.length).toBeGreaterThan(0);
    expect(rows.markedGaps.length).toBeGreaterThan(0);
    expect(rows.markedGaps).toEqual(files.markedGaps);
    expect(rows.markedGaps).toEqual([CONSENSO_FILE]);
    expect(rows.restoreReport).toContain(GAP_LINE);
    // A FULLY attributed page reports no gap in either path, so the mark is a decision
    // about a page and not a flag every page carries.
    expect(files.cleanGaps).toEqual([]);
    expect(rows.cleanGaps).toEqual([]);
    expect(rows.restoreReport).not.toContain(TARGET_TITLE);
  });

  it("prints the same acceptance and refusal counts for all four artifacts", () => {
    expect(files.restoreReport.length).toBeGreaterThan(0);
    expect(rows.restoreReport.length).toBeGreaterThan(0);
    expect(rows.restoreReport).toBe(files.restoreReport);
    expect(rows.firstReport).toBe(files.firstReport);
    // Pinned counts, so a backend that silently stops reporting is not "in parity".
    expect(rows.firstReport).toContain("1 page(s) assigned to 1 category(ies) (1 new)");
    expect(rows.firstReport).toContain("1 refused (1 unsupported)");
    expect(rows.firstReport).toContain("1 page(s) not fully attributed");
    expect(rows.restoreReport).toContain("1 link(s) restored");
    // A second run re-assigns the SAME membership: nothing new is minted in either path.
    expect(rows.restoreReport).toContain("0 page(s) assigned to 0 category(ies)");
  });
});
