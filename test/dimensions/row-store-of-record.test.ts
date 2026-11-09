/**
 * @file test/dimensions/row-store-of-record.test.ts
 * @description A row-backed wiki must be the STORE OF RECORD: after a real compile run
 * there is no file left that a fallback could serve, and every artifact is still readable
 * FROM THE ROWS once the on-disk copies are gone (S1, S2, S3, S4, S5, S8).
 *
 * ## The weakness this file closes
 *
 * The parity suite compares two backends, and a comparison like that cannot see a silent
 * fallback: when the row seam is unwired the run reaches for `.llmwiki/curated-links.json`,
 * or re-reads a page from `wiki/concepts`, and the link or the page still comes back. It
 * was measured (`odd/tasks/wiki-db-parity.md` L9 and L10): with `curatedLinks` removed
 * from the seam bundle, "restores the link" stayed GREEN while the Stack held nothing.
 *
 * So the claim tested here is not "both backends agree". It is "the row-backed half needs
 * nothing but rows": artifacts present in rows, no page/category/curated-link file on
 * disk, and the same artifacts still readable after the `sources/` directory -- the last
 * on-disk input a stage could fall back to -- has been deleted.
 *
 * ## What each case asserts, and why in this order
 *
 *  1. ANTI-VACUITY: the corpus run really produced all four artifacts in rows. A suite
 *     that removes files and then reads nothing would otherwise pass by asserting nothing.
 *  2. NO FALLBACK FILES: no `wiki/concepts/*.md`, no entry under `wiki/categories`, and no
 *     `.llmwiki/curated-links.json`. This is the case the unwired seam turns red.
 *  3. The on-disk sources were really removed, so what follows is a read after the fact.
 *  4. Aliases and the attribution gap, read back through the row PAGE READER the compile
 *     path itself uses (`createPageContentSource`).
 *  5. The category and its membership evidence, read through the CATEGORY STORE PORT.
 *  6. The curated records, read through the ROW CURATED-LINK STORE, at the count the
 *     corpus ends at: one record restored, then dropped, leaving none. A store that never
 *     forgot a dropped record answers 1 and fails here.
 *
 * Every artifact is read through the same port or reader the compile path installs on its
 * seams, never through a hand-written query: the question is what a stage would see.
 *
 * ## Why this suite FAILS instead of skipping when there is no database
 *
 * Same rule, same wording, same owner as the parity suite: `missingTestDatabase`
 * (`test/fixtures/test-database-handoff.ts`) decides, it throws unless
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` was set, and only that opt-out turns the file into
 * explicit skips under a title that says why. The gate itself, the probe Stack and the
 * `afterAll` teardown live in `createProbeSuite` (`test/fixtures/probe-stack-suite.ts`),
 * because the parity suite needs the identical three things and two copies of a rule about
 * what a missing database means are two places for it to be softened.
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProbeSuite } from "../fixtures/probe-stack-suite.js";
import { SISTEMAS_TITLE } from "../fixtures/category-scenario.js";
import { storeFor } from "../fixtures/category-rows.js";
import {
  CONSENSO_FILE,
  SISTEMAS_SLUG,
  TARGET_ALIAS,
  TARGET_SLUG,
  TARGET_TITLE,
  runParityCorpus,
  type ParityEvidence,
} from "../fixtures/store-parity-corpus.js";
import { createRowCuratedLinkStore } from "../../packages/wiki/src/dimensions/wiki/curated-links-row-store.js";
import { createPageContentSource } from "../../packages/wiki/src/dimensions/wiki/page-scan-source.js";
import { CATEGORIES_DIR, CONCEPTS_DIR, CURATED_LINKS_FILE, SOURCES_DIR } from "../../packages/wiki/src/utils/constants.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";

/** Where the failure and the skip reason say what needed a database: THIS file. */
const DATABASE_CONTEXT =
  "test/dimensions/row-store-of-record.test.ts (the row-store-of-record suite)";

/** The membership evidence the corpus' category carries for the merged page. */
const EVIDENCE_KEY = "consenso-distribuido";

/**
 * Every entry under `directory`, or none when the directory does not exist at all.
 *
 * @param directory - Absolute directory path.
 * @returns The entry names, relative to `directory`, in sorted order.
 */
async function entriesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
  return [...entries].sort();
}

/**
 * Every markdown file under `directory`: exactly what a page fallback would serve.
 *
 * @param directory - Absolute directory path.
 * @returns The `.md` entry names, sorted.
 */
async function markdownUnder(directory: string): Promise<string[]> {
  return (await entriesUnder(directory)).filter((name) => name.endsWith(".md"));
}

/**
 * One page's markdown, through the reader the compile path installs on its seams.
 *
 * @param slug - Page slug under `wiki/concepts`.
 * @returns Frontmatter plus body, or undefined when the Stack holds no such page.
 */
async function readRowPage(slug: string): Promise<string | undefined> {
  const { harness } = probeStack();
  return await createPageContentSource(harness.db, harness.stackId).read("concepts", slug);
}

/**
 * Coerce a frontmatter list value into strings, dropping anything else.
 *
 * @param raw - The parsed frontmatter field.
 * @returns The field's strings, or an empty list.
 */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(String) : [];
}

const suite = await createProbeSuite({
  label: "row-store-of-record",
  databaseContext: DATABASE_CONTEXT,
  title: "a row-backed wiki keeps no file a fallback could serve",
});
const { probeStack, runSuite } = suite;

// `describe.skip` still COLLECTS the cases and runs none of them, so an opted-out run
// reports them as skips under a title that says why, instead of a bare green count.
runSuite(suite.suiteTitle, () => {
  let projectRoot = "";
  let rows: ParityEvidence;
  let removedSources = 0;
  let saved: NodeJS.ProcessEnv = { ...process.env };

  beforeAll(async () => {
    saved = { ...process.env };
    projectRoot = await mkdtemp(path.join(os.tmpdir(), "row-store-of-record-"));
    Object.assign(process.env, probeStack().env());
    rows = await runParityCorpus(projectRoot, probeStack().harness);
    // The on-disk sources are the last input a stage could fall back to. Removing them
    // here is what makes every read below a read FROM THE ROWS; the count is kept so a
    // run that silently wrote no source files cannot pass as "nothing to fall back to".
    removedSources = (await entriesUnder(path.join(projectRoot, SOURCES_DIR))).length;
    await rm(path.join(projectRoot, SOURCES_DIR), { recursive: true, force: true });
  });

  // This suite's own temp root holds real page, source and category files, and the probe
  // Stack owns a database domain: both go away here.
  afterAll(() => suite.teardown(projectRoot, saved));

  it("really recorded all four artifacts in rows before anything was removed", () => {
    expect(rows.targetAliases).toEqual(expect.arrayContaining([TARGET_ALIAS]));
    expect(rows.curatedRecords.map((record) => record.stableKey)).toHaveLength(1);
    expect(rows.category?.members.map((member) => member.evidenceKey)).toEqual([EVIDENCE_KEY]);
    expect(rows.markedGaps).toEqual([CONSENSO_FILE]);
  });

  it("left no page, category or curated-link file a fallback could serve", async () => {
    expect(await markdownUnder(path.join(projectRoot, CONCEPTS_DIR))).toEqual([]);
    expect(await entriesUnder(path.join(projectRoot, CATEGORIES_DIR))).toEqual([]);
    await expect(stat(path.join(projectRoot, CURATED_LINKS_FILE))).rejects.toThrow(/ENOENT/u);
  });

  it("removed the on-disk sources the remaining reads must not need", async () => {
    expect(removedSources).toBeGreaterThan(0);
    expect(await entriesUnder(path.join(projectRoot, SOURCES_DIR))).toEqual([]);
  });

  it("still serves the aliases from the rows", async () => {
    const target = parseFrontmatter(await readRowPage(TARGET_SLUG) ?? "");
    expect(stringList(target.meta.aliases)).toEqual(rows.targetAliases);
    expect(stringList(target.meta.aliases)).toContain(TARGET_ALIAS);
    expect(target.meta.title).toBe(TARGET_TITLE);
  });

  it("still serves the attribution gap from the rows", async () => {
    const merged = parseFrontmatter(await readRowPage(SISTEMAS_SLUG) ?? "");
    expect(stringList(merged.meta.attributionGaps)).toEqual([CONSENSO_FILE]);
    expect(merged.body).toContain("consenso distribuido");
  });

  it("still serves the category and its membership evidence from the rows", async () => {
    const category = await storeFor(probeStack().harness).read(SISTEMAS_SLUG);
    expect(category?.canonicalName).toBe(SISTEMAS_TITLE);
    expect(category?.members.length ?? 0).toBeGreaterThan(0);
    expect(category?.members[0]?.evidenceKey).toBe(EVIDENCE_KEY);
  });

  it("still forgets the curated record the corpus dropped", async () => {
    const { harness } = probeStack();
    const records = await createRowCuratedLinkStore(harness.db, harness.stackId).load();
    // The corpus restored one record, then dropped it when the anchor went away, so the
    // store of record must hold NONE: a store that never deleted answers 1 here.
    expect(rows.recordsAfterDrop).toBe(0);
    expect(records).toHaveLength(rows.recordsAfterDrop);
  });
});
