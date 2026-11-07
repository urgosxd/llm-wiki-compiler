/**
 * @file test/dimensions/row-page-curated-links.test.ts
 * @description Curated links are DURABLE IN THE STACK, and the shared overlay re-validates
 * their anchors on every render (S3, S8).
 *
 * ## The gap this file closes
 *
 * A curated link is a promise a reference review makes about a page body it did not
 * write: the mention that justified the link, plus enough prose around it to find that
 * mention again in a body nobody has written yet. The promise was kept in
 * `.llmwiki/curated-links.json` -- a file on the host that compiled, NOT in the Stack --
 * so two hosts serving one Stack did not share their curated links, and a Stack whose
 * pages live in rows had no durable record of them at all. `wiki.curated_links` exists
 * for that; this file proves the compile path WRITES it and READS IT BACK.
 *
 * ## What each case is allowed to prove
 *
 *  - the record is asserted against the raw `wiki.curated_links` ROWS, read with SQL.
 *    Reading them back through the store under test would pass with the table never
 *    written, because the writer and the reader would be broken in the same direction.
 *  - every field is asserted, because a store that keeps the key and loses the anchor
 *    context cannot re-anchor anything: `stableKey`, both page ids, the anchor's text
 *    and its two prose sides, the provenance channel and `createdAt`.
 *  - the re-anchor cases drive real `compileAndReport` runs whose regenerated bodies
 *    differ from the body the record was made from. The mention survives in one and is
 *    gone in the other, and the gone case asserts the ROW is deleted and the run SAYS SO
 *    through the same reporting path the file store uses.
 *  - the parity case runs the whole scenario twice -- once row-backed, once file-backed
 *    -- and compares the records, the restored body and the drop report. Equivalent
 *    observable behaviour is the requirement; byte-identical storage is not.
 *
 * ## Why the comparison is EXACT
 *
 * It used to fold the anchor's two prose sides, because a row-backed page read back
 * through `renderPageMarkdown` yielded a body with one blank line more at its start than
 * the same page read from disk. That was not a formatting detail: the renderer re-added
 * the separator `parseFrontmatter` had already stripped, so the resolver's write-back
 * added one leading newline on every rewrite. It is fixed at the source and pinned by
 * `row-page-round-trip.test.ts`, which is why nothing here trims any more: an extra byte
 * in these windows is a regression and has to fail.
 *
 * Every case goes through `compileAndReport` on a real Stack with the real document
 * store: a store that only works when a test calls it directly proves nothing about the
 * compile path (S8).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { compileAndReport } from "../../src/compiler/index.js";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { saveSourceDocument } from "../../src/dimensions/wiki/source-documents-store.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { readConceptPage } from "../fixtures/concept-page.js";
import { extractionAnswer, stubCompileProvider } from "../fixtures/compile-provider.js";
import { curatedRecordsFor, writeSource, type StoredCuratedLink } from "../fixtures/curated-scenario.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";

/** Source whose page MENTIONS the link target by an alias. */
const ALPHA_FILE = "alpha.md";

/** Source whose ingest creates the link target, titled `Vector DB`. */
const BETA_FILE = "beta.md";

/** The earlier page's title, and the slug it is published under. */
const ALPHA_TITLE = "Alpha Topic";
const ALPHA_SLUG = "alpha-topic";

/** The link target's title, and the slug it is published under. */
const TARGET_TITLE = "Vector DB";
const TARGET_SLUG = "vector-db";

/**
 * The alias the identity stage folds from beta's two spellings.
 *
 * An ALIAS and not the title, on purpose: the resolver re-wraps mentions of page TITLES
 * on every render, so a title-anchored case would pass without the overlay running at
 * all. Only an alias mention can be destroyed by a regeneration.
 */
const TARGET_ALIAS = "Vector Database";

/** Marker that routes the extraction stub to the beta source. */
const BETA_MARKER = "BETA SOURCE TEXT";

/** Alpha's body: names the target by its alias, never by its title. */
const ALPHA_BODY = `Alpha Topic stores vectors in a ${TARGET_ALIAS}. ^[alpha.md:1-1]`;

/** Alpha's body after a source revision that changes nothing the record needs. */
const ALPHA_BODY_REVISED = `${ALPHA_BODY} Revised.`;

/** Alpha's body once the mention that justified the curated link is gone. */
const ALPHA_BODY_WITHOUT_TARGET = "Alpha Topic stores vectors only. ^[alpha.md:1-1]";

/** Beta's body: the target article itself. */
const BETA_BODY = "Vector DB keeps embeddings for retrieval. ^[beta.md:1-1]";

/** The link markup the overlay has to restore. */
const LINK = `[[${TARGET_SLUG}|${TARGET_ALIAS}]]`;

/** The per-record line the overlay prints for a record it cannot re-anchor. */
const DROP_LINE = `Curated link dropped on concepts/${ALPHA_SLUG}: concepts/${TARGET_SLUG} ` +
  `— anchor-missing ("${TARGET_ALIAS}" is no longer a plain mention).`;

/** The run's counted line for that drop, through the shared curated-link tally. */
const DROP_SUMMARY = "Curated links: 0 link(s) restored, 1 dropped (1 anchor-missing).";

/** Every column of one stored curated link, as Postgres returns it. */
interface LinkRow extends Record<string, unknown> {
  readonly stable_key: string;
  readonly source_page_id: string;
  readonly target_page_id: string;
  readonly anchor_text: string;
  readonly anchor_before: string;
  readonly anchor_after: string;
  readonly provenance: string;
  readonly created_at: Date | string;
}

/**
 * Answer the three provider calls a compile makes for this scenario.
 *
 * Extraction routes on the source TEXT, because the extraction prompt also carries the
 * existing wiki index and therefore every title compiled so far.
 *
 * @param alphaBody - Alpha's rendered body for the run about to happen.
 */
function stubProvider(alphaBody: string): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  stubCompileProvider({
    extraction: (system) =>
      system.includes(BETA_MARKER) ? betaExtraction() : extractionAnswer([ALPHA_TITLE]),
    body: (system) =>
      system.includes(`Concept to write about: "${TARGET_TITLE}"`) ? BETA_BODY : alphaBody,
    review: () => JSON.stringify({ should_link: true, mention: TARGET_ALIAS }),
  });
}

/**
 * Beta's extraction: ONE concept under two spellings the canonical key folds.
 *
 * This is how a page legitimately acquires an alias, and therefore how the scenario gets
 * a name the resolver will never re-wrap on its own.
 *
 * @returns The extraction tool call's answer.
 */
function betaExtraction(): string {
  return JSON.stringify({
    concepts: [
      { concept: TARGET_TITLE, summary: "Vector storage.", is_new: true, confidence: 0.9 },
      { concept: TARGET_ALIAS, summary: "Vector storage.", is_new: false, confidence: 0.5 },
    ],
  });
}

/**
 * Ingest one document into the Stack (when there is one) and leave the same bytes on
 * disk, so the same corpus can be replayed through the file-backed path.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @param filename - Source filename, used as the identity AND written to `sources/`.
 * @param document - Markdown the compiler extracts from.
 */
async function ingest(
  root: string,
  harness: KgPostgresHarness | undefined,
  filename: string,
  document: string,
): Promise<void> {
  if (harness !== undefined) {
    await saveSourceDocument(harness.db, harness.stackId, {
      title: filename.replace(/\.md$/, ""),
      document,
      source: filename,
    });
  }
  await writeSource(root, filename, document);
}

/**
 * Ingest alpha, then beta -- creating the article and its folded alias -- so a LATER
 * ingest of beta's article makes the review curate a link into alpha's page.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 */
async function curateLink(root: string, harness?: KgPostgresHarness): Promise<void> {
  stubProvider(ALPHA_BODY);
  await ingest(root, harness, ALPHA_FILE, "# Alpha\n\nAlpha describes the store.\n");
  await compileAndReport(root);
  stubProvider(ALPHA_BODY);
  await ingest(root, harness, BETA_FILE, `# Beta\n\n${BETA_MARKER}. Vector DB keeps embeddings.\n`);
  await compileAndReport(root);
}

/**
 * Re-ingest alpha's source with a new body, and compile.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @param body - Alpha's body for the regenerated page.
 */
async function reingestAlpha(
  root: string,
  harness: KgPostgresHarness | undefined,
  body: string,
): Promise<void> {
  stubProvider(body);
  await ingest(root, harness, ALPHA_FILE, `# Alpha\n\nAlpha describes the store, ${body}.\n`);
  await compileAndReport(root);
}

/**
 * The curated records a backend holds, in the shape the file store writes them.
 *
 * The row backend is read with SQL rather than through the store module: the assertion
 * is about what the TABLE holds, and a store asked to read its own write cannot tell a
 * missing row from a mis-read one.
 *
 * @param root - Project root, for the file backend.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns The stored records, empty when nothing was recorded.
 */
async function storedRecords(
  root: string,
  harness: KgPostgresHarness | undefined,
): Promise<StoredCuratedLink[]> {
  if (harness === undefined) return await curatedRecordsFor(root, `concepts/${ALPHA_SLUG}`);
  const rows = await harness.db.execute<LinkRow>(sql`
    select stable_key, source_page_id, target_page_id, anchor_text, anchor_before,
           anchor_after, provenance, created_at
    from wiki.curated_links
    where stack_id = ${harness.stackId}
    order by stable_key asc
  `);
  return rows.map((row) => ({
    stableKey: row.stable_key,
    sourcePageId: row.source_page_id,
    targetPageId: row.target_page_id,
    anchor: { text: row.anchor_text, before: row.anchor_before, after: row.anchor_after },
    provenance: row.provenance,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * The prose of the earlier page, read back from whichever backend holds it.
 *
 * @param root - Project root, for the file backend.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns The page's body without frontmatter.
 */
async function alphaBodyText(
  root: string,
  harness: KgPostgresHarness | undefined,
): Promise<string> {
  if (harness === undefined) {
    return parseFrontmatter(await readConceptPage(root, ALPHA_SLUG)).body;
  }
  const page = await getStoredPage(harness.db, harness.stackId, "concepts", ALPHA_SLUG);
  return page?.body ?? "";
}

/**
 * The prose around the mention, as both backends must agree on it.
 *
 * Compared byte for byte, including the newlines at either end: those come from the
 * body the record was sliced out of, and the two backends are required to hold the same
 * body. See the file header for the renderer defect this used to force it to fold.
 *
 * @param record - A stored record from either backend.
 * @returns The fields the two stores are required to agree on.
 */
function comparable(record: StoredCuratedLink): Record<string, unknown> {
  return {
    stableKey: record.stableKey,
    sourcePageId: record.sourcePageId,
    targetPageId: record.targetPageId,
    anchor: record.anchor,
    provenance: record.provenance,
  };
}

/** What two backends' runs of the same scenario are compared on. */
interface ScenarioResult {
  records: StoredCuratedLink[];
  restoredBody: string;
  dropReport: string;
  remaining: StoredCuratedLink[];
}

/**
 * Run the WHOLE scenario -- curate, restore, drop -- and collect what it produced.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns The records, the restored body, what the drop reported and what is left.
 */
async function runScenario(
  root: string,
  harness?: KgPostgresHarness,
): Promise<ScenarioResult> {
  await curateLink(root, harness);
  await reingestAlpha(root, harness, ALPHA_BODY_REVISED);
  const restoredBody = await alphaBodyText(root, harness);
  const records = await storedRecords(root, harness);
  const io = captureProcessIo();
  await reingestAlpha(root, harness, ALPHA_BODY_WITHOUT_TARGET);
  const printed = io.out();
  return {
    records,
    restoredBody,
    remaining: await storedRecords(root, harness),
    dropReport: [DROP_LINE, DROP_SUMMARY]
      .filter((line) => printed.includes(line))
      .join("\n"),
  };
}

/**
 * Run `body` with NO Stack installed, so every seam resolves to the file backend.
 *
 * @param body - Work to run without a Stack.
 * @returns Whatever `body` returns.
 */
async function withoutStack<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.AKS_STACK_ID;
  delete process.env.AKS_STACK_ID;
  try {
    return await body();
  } finally {
    if (saved !== undefined) process.env.AKS_STACK_ID = saved;
  }
}

describe("curated links through the row seam", () => {
  it("stores every field of the record in wiki.curated_links", () =>
    withRowsStack("row-curated-fields", async ({ root, harness }) => {
      await curateLink(root, harness);

      const records = await storedRecords(root, harness);
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record.sourcePageId).toBe(`concepts/${ALPHA_SLUG}`);
      expect(record.targetPageId).toBe(`concepts/${TARGET_SLUG}`);
      expect(record.provenance).toBe("model-verdict");
      // The anchor is what makes the record re-anchorable: text plus both prose sides,
      // byte for byte. The leading newline is the blank line that separates frontmatter
      // from prose, which the file path's body carries too (`row-page-round-trip`).
      expect(record.anchor.text).toBe(TARGET_ALIAS);
      expect(record.anchor.before).toBe(`\nAlpha Topic stores vectors in a `);
      expect(record.anchor.after).toBe(`. ^[alpha.md:1-1]\n`);
      // A timestamp that reads back as itself proves it survived `timestamptz`.
      expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
      expect(record.stableKey).toHaveLength(16);
    }));

  it("reads the record back on a later run and restores the link", () =>
    withRowsStack("row-curated-restore", async ({ root, harness }) => {
      await curateLink(root, harness);
      const recorded = await storedRecords(root, harness);

      // A revision whose prose still holds the mention. The regenerated body carries no
      // link, and the alias has no passive channel, so only the stored record can put it
      // back -- which means this run really read the row.
      await reingestAlpha(root, harness, ALPHA_BODY_REVISED);

      expect(await alphaBodyText(root, harness)).toContain(LINK);
      // Read back ACROSS RUNS, field for field, `createdAt` included.
      expect(await storedRecords(root, harness)).toEqual(recorded);
    }));

  it("drops the record and reports it when the anchor is gone", () =>
    withRowsStack("row-curated-drop", async ({ root, harness }) => {
      await curateLink(root, harness);
      const io = captureProcessIo();

      await reingestAlpha(root, harness, ALPHA_BODY_WITHOUT_TARGET);

      const body = await alphaBodyText(root, harness);
      expect(body).not.toContain(LINK);
      // Reported, per record AND in the run's tally: a dropped link that nobody can see
      // is the silent loss S3 forbids.
      expect(io.out()).toContain(DROP_LINE);
      expect(io.out()).toContain(DROP_SUMMARY);
      // Forgotten, so the next run does not re-report a link that is already gone.
      expect(await storedRecords(root, harness)).toEqual([]);
    }));

  it("records, restores and reports exactly what the file path does", () =>
    withRowsStack("row-curated-parity", async ({ root, harness }) => {
      const filesRoot = path.join(root, "files");
      const rowsRoot = path.join(root, "rows");
      await mkdir(filesRoot);
      await mkdir(rowsRoot);

      const fromFiles = await withoutStack(() => runScenario(filesRoot));
      const fromRows = await runScenario(rowsRoot, harness);

      expect(fromFiles.records).toHaveLength(1);
      expect(fromRows.records.map(comparable)).toEqual(fromFiles.records.map(comparable));
      expect(fromRows.restoredBody).toBe(fromFiles.restoredBody);
      expect(fromRows.restoredBody).toContain(LINK);
      expect(fromRows.remaining).toEqual(fromFiles.remaining);
      expect(fromRows.remaining).toEqual([]);
      expect(fromRows.dropReport).toBe(fromFiles.dropReport);
      expect(fromRows.dropReport).toContain(DROP_LINE);
    }));
});
