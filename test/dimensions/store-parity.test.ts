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
 *
 * ## Why this suite FAILS instead of skipping when there is no database
 *
 * The acceptance test of a cross-backend feature is the worst possible place to report a
 * green that asserts nothing: a `describe.skipIf` on a reachability probe printed `7
 * skipped (7)` beside a zero exit status, and not one of the four parity claims above had
 * been measured. A skip is not a smaller test, it is a pass with the test removed.
 *
 * So the decision is the repository's, taken HERE: `missingTestDatabase`
 * (`test/fixtures/test-database-handoff.ts`, the root twin of
 * `packages/llmwiki-kg/ts/src/testing/no-database.ts`) THROWS unless the one documented
 * opt-out `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is set, and only then does this file skip --
 * with the reason printed and the title annotated, so an offline run is explicit about
 * what it dropped instead of quietly passing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProbeStack, type ProbeStack } from "./harness-lifecycle.js";
import { missingTestDatabase } from "../fixtures/test-database-handoff.js";
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

/** Where the failure and the skip reason say what needed a database: THIS file. */
const DATABASE_CONTEXT =
  "test/dimensions/store-parity.test.ts (the file-backed/row-backed parity suite)";

/** A probe Stack, or the message explaining why there is none. */
type ProbeOutcome =
  | { readonly stack: ProbeStack }
  | { readonly failure: string };

/**
 * Provision this suite's probe Stack, keeping a provisioning failure as EVIDENCE.
 *
 * Letting the fixture's error escape would report a randomly suffixed Stack label instead
 * of this file, and would leave the suite with no statement of its own about the database
 * it needs -- which is the whole point of the rule applied below.
 *
 * @returns The Stack, or the message that explains why there is none.
 */
async function provisionProbe(): Promise<ProbeOutcome> {
  try {
    return { stack: await createProbeStack("store-parity") };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The informative part of a caught "no database" failure, without its advice block.
 *
 * The fixture's message already ends in the shared "supply a database" advice. Quoting it
 * whole as this suite's `Observed:` detail would print that block twice, and a failure
 * that repeats itself reads as two problems instead of one.
 *
 * @param message - The caught message.
 * @returns What was observed, up to the first advice line.
 */
function observedFrom(message: string): string {
  const kept: string[] = [];
  for (const line of message.split("\n")) {
    if (ADVICE_MARKERS.some((marker) => line.startsWith(marker))) break;
    kept.push(line);
  }
  const observed = kept.join("\n").trim();
  return observed === "" ? message : observed;
}

/** Lines that begin the shared advice a nested failure already carries. */
const ADVICE_MARKERS = [
  "Database-backed suites must not skip here:",
  "Skipping is not an option here:",
  "Supply a database in any of these ways:",
];

/**
 * What this suite does when it has no usable database: FAIL loudly, or (only with the
 * documented opt-out) skip EXPLICITLY and say why.
 *
 * The decision and its wording belong to `missingTestDatabase`, so this file cannot
 * invent a softer rule than the rest of the repository. It decides only whether the
 * database is usable: a Stack the harness could not provision is as unusable as a server
 * that did not answer, and both used to become the same silent skip.
 *
 * @param outcome - The probe Stack, or why provisioning failed.
 * @returns "" when the database is usable; otherwise the reason the skip reports.
 * @throws the shared actionable failure when `LLMWIKI_TEST_ALLOW_NO_DATABASE` is not `1`.
 */
function databaseSkipReason(outcome: ProbeOutcome): string {
  if ("stack" in outcome && outcome.stack.harness.reachable) return "";
  const observed = "failure" in outcome
    ? observedFrom(outcome.failure)
    : `the kg harness reported reachable = false for stack ${outcome.stack.harness.stackId}`
      + " — the warning printed above says whether the server was unreachable or the Stack"
      + " could not be provisioned";
  const missing = missingTestDatabase(DATABASE_CONTEXT, observed);
  if (missing.error !== undefined) throw missing.error;
  console.warn(`${DATABASE_CONTEXT}: every case in this file is skipped.`);
  console.warn(missing.message);
  return missing.message;
}

/**
 * This suite's probe Stack.
 *
 * Unwrapped through a guard rather than narrowed per case: the cases only exist when the
 * database does, so a run that somehow reached them without a Stack is a defect that must
 * be loud instead of asserting against `undefined`.
 *
 * @returns The provisioned Stack.
 */
function probeStack(): ProbeStack {
  if (!("stack" in probeOutcome)) throw new Error(`${DATABASE_CONTEXT}: ${probeOutcome.failure}`);
  return probeOutcome.stack;
}

const probeOutcome = await provisionProbe();
const skipReason = databaseSkipReason(probeOutcome);

/** Title the runner prints; annotated when the opt-out turned the suite into skips. */
const SUITE_TITLE = skipReason === ""
  ? "file-backed and row-backed wikis behave identically"
  : "file-backed and row-backed wikis behave identically — SKIPPED: no database, reason below";

// `describe.skip` still COLLECTS the cases and runs none of them, so an opted-out run
// reports them as skips under a title that says why, instead of a bare green count.
const runSuite = skipReason === "" ? describe : describe.skip;

runSuite(SUITE_TITLE, () => {
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
    Object.assign(process.env, probeStack().env());
    rows = await runParityCorpus(rowsRoot, probeStack().harness);
  });

  afterAll(async () => {
    process.env = saved;
    vi.restoreAllMocks();
    // The temp root holds two real compiles' worth of page files; it is this suite's to
    // remove, and leaving it behind is how a test run silently fills the host's /tmp.
    await rm(projectRoot, { recursive: true, force: true });
    await probeStack().harness.cleanup();
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
