/**
 * @file test/dimensions/row-page-attribution-gaps.test.ts
 * @description A row-backed page that draws on a source it does not cite is MARKED,
 * COUNTED and NAMED -- and is never read back as fully attributed (S5, S8).
 *
 * ## The gap this file closes
 *
 * The attribution rule landed on the file-backed store only. `buildMergedFrontmatter`
 * writes `attributionGaps` into the page's own frontmatter, so a page compiled to disk
 * carries the fact that its prose leaves a contributing source untraced, and every
 * later reader of those bytes sees it. A page compiled to a ROW kept the fact nowhere:
 * `wiki.pages` had no column for it and `renderPageMarkdown` rebuilt the page without
 * it, so a DB-backed page that absorbed a source without citing it read back as fully
 * attributed. That is the run-level warning surviving one run and the page itself
 * lying forever.
 *
 * ## Why the corpus names sources by FILENAME
 *
 * A citation marker is `^[<file>:<lines>]`, and the census compares those names with
 * the page's contributing sources. The file-backed path records filenames, so these
 * cases ingest documents under their filenames as the source identity: the same body
 * then means the same thing through either store, and the counted line names the same
 * source. Anything else would compare two different vocabularies and call the
 * difference a parity result.
 *
 * ## What the third case is for
 *
 * Persisting the column is not enough. `renderPageMarkdown` is the ONLY way a row
 * becomes markdown, and the resolver rewrites a page by patching its body inside that
 * rendered text (`resolver.ts` `rewritePage`). If the gap is not rendered back, the
 * next run that touches the page through link resolution writes the row again WITHOUT
 * it, and the page silently becomes fully attributed. That case fails exactly then.
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { saveSourceDocument } from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { getStoredPage } from "../../packages/wiki/src/dimensions/wiki/page-store.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { readConceptPage } from "../fixtures/concept-page.js";
import { extractionAnswer, stubCompileProvider } from "../fixtures/compile-provider.js";
import { writeSource } from "../fixtures/curated-scenario.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";

/** The concept both documents substantiate: the merged article's slug. */
const CONCEPT = "Vector DB";

/** The page slug that concept is published under. */
const SLUG = "vector-db";

/** The concept a later run creates, and the word the marked page already uses. */
const LATER_CONCEPT = "Embeddings";

/** The body that attributes BOTH contributing sources. */
const FULL_BODY = `${CONCEPT} merges both accounts. ^[alpha.md:1-1, beta.md:1-1]`;

/** The body that attributes alpha only, leaving beta's account untraced. */
const ALPHA_ONLY_BODY = `${CONCEPT} is where Embeddings live, alpha says. ^[alpha.md:1-1]`;

/** The counted line the run prints for the one imperfect page. */
const GAP_LINE = "Attribution: 1 page(s) not fully attributed (1 source reference(s) missing) " +
  `— ${CONCEPT} is missing beta.md`;

/**
 * Install the provider credentials a compile needs and one answer per call.
 *
 * Each run of these cases renders exactly ONE page, so the answer needs no routing on
 * the prompt: the extraction reports `title`, and every completion returns `body`.
 *
 * @param title - The concept title the extraction reports.
 * @param body - The page body the completion returns, citation markers included.
 */
function stubOnePage(title: string, body: string): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  stubCompileProvider({
    extraction: () => extractionAnswer([title]),
    body: () => body,
  });
}

/**
 * Ingest one document under its own filename, and leave the same bytes on disk.
 *
 * @param root - Project root.
 * @param filename - Source filename, used as the identity AND written to `sources/`.
 * @param document - Markdown the compiler extracts from.
 * @param harness - The suite's Stack.
 */
async function ingest(
  root: string,
  harness: KgPostgresHarness,
  filename: string,
  document: string,
): Promise<void> {
  await saveSourceDocument(harness.db, harness.stackId, {
    title: filename.replace(/\.md$/, ""),
    document,
    source: filename,
  });
  await writeSource(root, filename, document);
}

/** Both documents of the merge case, so every case starts from the same corpus. */
async function ingestPair(root: string, harness: KgPostgresHarness): Promise<void> {
  await ingest(root, harness, "alpha.md", "# Alpha\n\nAlpha describes the store.\n");
  await ingest(root, harness, "beta.md", "# Beta\n\nBeta describes the same store.\n");
}

/**
 * The `attribution_gaps` COLUMN of one stored page, read with SQL rather than through
 * the store: the assertion is about what the row holds, not about what a reader says.
 *
 * @param harness - The suite's Stack.
 * @param slug - Page slug.
 * @returns The stored gap list, empty when the page is fully attributed.
 */
async function storedGaps(harness: KgPostgresHarness, slug: string): Promise<string[]> {
  const rows = await harness.db.execute<{ gaps: unknown }>(sql`
    select attribution_gaps as gaps from wiki.pages
    where stack_id = ${harness.stackId} and page_directory = 'concepts' and slug = ${slug}
  `);
  const raw = rows[0]?.gaps;
  return Array.isArray(raw) ? raw.map(String) : [];
}

describe("attribution gaps through the row seam", () => {
  it("marks the row, counts the page and names the missing source", () =>
    withRowsStack("row-gap-marked", async ({ root, harness }) => {
      const io = captureProcessIo();
      await ingestPair(root, harness);
      stubOnePage(CONCEPT, ALPHA_ONLY_BODY);

      await compileAndReport(root);

      expect(await storedGaps(harness, SLUG)).toEqual(["beta.md"]);
      expect(io.out()).toContain(GAP_LINE);
    }));

  it("leaves a fully attributed page with no gap at all", () =>
    withRowsStack("row-gap-none", async ({ root, harness }) => {
      const io = captureProcessIo();
      await ingestPair(root, harness);
      stubOnePage(CONCEPT, FULL_BODY);

      await compileAndReport(root);

      // The file path omits the field entirely for a complete page rather than writing
      // an empty array; the row twin of that omission is an empty list, and no line.
      expect(await storedGaps(harness, SLUG)).toEqual([]);
      expect(io.out()).not.toContain("Attribution");
    }));

  it("carries the same gap the file-backed run writes into frontmatter", () =>
    withRowsStack("row-gap-parity", async ({ root, harness }) => {
      await ingestPair(root, harness);
      stubOnePage(CONCEPT, ALPHA_ONLY_BODY);
      await compileAndReport(root);
      const fromRows = await storedGaps(harness, SLUG);

      // The same corpus through the file-backed path: no Stack, so every seam is the
      // on-disk one and the gap lands in the page's frontmatter instead of a column.
      delete process.env.AKS_STACK_ID;
      stubOnePage(CONCEPT, ALPHA_ONLY_BODY);
      await compileAndReport(root);
      const { meta } = parseFrontmatter(await readConceptPage(root, SLUG));

      expect(meta.attributionGaps).toEqual(fromRows);
      expect(fromRows).toEqual(["beta.md"]);
    }));

  it("keeps the gap when a later run rewrites the page from its row", () =>
    withRowsStack("row-gap-rewrite", async ({ root, harness }) => {
      await ingestPair(root, harness);
      stubOnePage(CONCEPT, ALPHA_ONLY_BODY);
      await compileAndReport(root);

      // A new page whose title the marked article already mentions. The INBOUND link
      // pass rewrites the unchanged article by patching its body inside the markdown
      // `renderPageMarkdown` rebuilt from the row -- the one write that can carry the
      // gap away when the rendered page does not include it.
      stubOnePage(LATER_CONCEPT, `${LATER_CONCEPT} are vectors.`);
      await ingest(root, harness, "later.md", "# Later\n\nA later account.\n");
      await compileAndReport(root);

      const rewritten = await getStoredPage(harness.db, harness.stackId, "concepts", SLUG);
      // PRECONDITION: the rewrite happened, so this case really exercises the write
      // that goes through the rendered page rather than passing on a page nobody read.
      expect(rewritten?.body).toContain("[[embeddings");
      expect(await storedGaps(harness, SLUG)).toEqual(["beta.md"]);
    }));
});
