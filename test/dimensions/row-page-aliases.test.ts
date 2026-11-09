/**
 * @file test/dimensions/row-page-aliases.test.ts
 * @description Concept aliases survive the ROW seam, in both directions (S2, S8).
 *
 * ## The gap this file closes
 *
 * In the file-backed store an alias is a page fact: `applyDeclaredAliases` writes the
 * names a page folded away into its own frontmatter, and every later run reads them back
 * so the identity tier folds by RULE instead of re-deciding the same synonym. The
 * row-backed store kept aliases nowhere: the sink parsed the rendered frontmatter into
 * `wiki.pages` columns that had no `aliases` column, `renderPageMarkdown` rebuilt the
 * page from those columns without one, and the renderer re-read the page it was about to
 * replace from `wiki/concepts` -- a directory a row-backed project does not have. So the
 * decision was lost on the first round trip and silently re-derived on every run.
 *
 * ## What each case is allowed to prove
 *
 *  - the WRITE half is asserted against the raw `aliases` column, read with SQL: a test
 *    that read it back through `getStoredPage` would pass with the column never written,
 *    because the writer and the reader would be broken in the same direction;
 *  - the READ half drives a SECOND `compileAndReport` whose document names the concept by
 *    its canonical name only, so nothing in that run re-derives the folded name: it can
 *    survive only if the previous run's row is read back into the page before the page is
 *    re-rendered;
 *  - the PARITY case ingests the same input through both stores and compares the aliases
 *    each page carries, after the first run and after the second.
 *
 * Every case calls the real pipeline (`compileAndReport`) after ingesting through the
 * real document store: an aliases round trip that only works when a test calls the
 * renderer directly is exactly the unwired-stage defect S8 forbids.
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { listStoredPagesUnfiltered } from "../../packages/wiki/src/dimensions/wiki/page-store.js";
import { saveSourceDocument } from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { readConceptPage } from "../fixtures/concept-page.js";
import { extractionAnswer, stubCompileProvider } from "../fixtures/compile-provider.js";
import { writeSource } from "../fixtures/curated-scenario.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";

/** Filename the first document is ingested under, and cited as. */
const ALPHA_FILE = "vectors.md";

/** The two names that document uses for one concept. */
const SYNONYMS = ["Vector DB", "Vector Database"];

/** The canonical name alone, which is what the second document names. */
const CANONICAL_ONLY = ["Vector DB"];

/** Page the group is published under: the lexicographic tie-break wins. */
const CANONICAL_SLUG = "vector-db";

/** Source text of every document these cases ingest. */
const DOCUMENT = "# Vectors\n\nA source account of the vector store.\n";

/**
 * Answer extraction with the given concept names and a plain page body.
 *
 * @param titles - Concept titles every extraction reports.
 */
function stubNames(titles: readonly string[]): void {
  stubCompileProvider({
    extraction: () => extractionAnswer(titles),
    body: () => "The vector store indexes embeddings.",
  });
}

/**
 * Ingest one document under its own filename, and leave the same bytes on disk.
 *
 * The filename is the source identity so that a later FILE-backed run of the same corpus
 * reads the same vocabulary; the on-disk copy is what that run consumes.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack.
 * @param filename - Source filename, used as the identity and written to `sources/`.
 */
async function ingest(
  root: string,
  harness: KgPostgresHarness,
  filename: string,
): Promise<void> {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  await saveSourceDocument(harness.db, harness.stackId, {
    title: filename.replace(/\.md$/, ""),
    document: DOCUMENT,
    source: filename,
  });
  await writeSource(root, filename, DOCUMENT);
}

/**
 * Ingest one document and run a real row-backed compile over the wiki.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack.
 * @param filename - Source filename to ingest.
 * @param titles - Concept titles the extraction should report.
 */
async function compileDocument(
  root: string,
  harness: KgPostgresHarness,
  filename: string,
  titles: readonly string[],
): Promise<void> {
  await ingest(root, harness, filename);
  stubNames(titles);
  await compileAndReport(root);
}

/**
 * Concept slugs the row corpus holds, in name order.
 *
 * @param harness - The suite's Stack.
 * @returns Page slugs under `wiki.pages` for the concepts namespace.
 */
async function conceptSlugs(harness: KgPostgresHarness): Promise<string[]> {
  const pages = await listStoredPagesUnfiltered(harness.db, harness.stackId);
  return pages
    .filter((page) => page.pageDirectory === "concepts")
    .map((page) => page.slug)
    .sort();
}

/**
 * The `aliases` COLUMN of one stored page, read with SQL rather than through the store.
 *
 * @param harness - The suite's Stack.
 * @param slug - Page slug.
 * @returns The stored alias list, empty when the column holds no name.
 */
async function storedAliases(harness: KgPostgresHarness, slug: string): Promise<string[]> {
  const rows = await harness.db.execute<{ aliases: unknown }>(sql`
    select aliases from wiki.pages
    where stack_id = ${harness.stackId} and page_directory = 'concepts' and slug = ${slug}
  `);
  const raw = rows[0]?.aliases;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/**
 * The aliases a page FILE carries, as the frontmatter parser reports them.
 *
 * @param root - Project root.
 * @returns The page's declared aliases.
 */
async function fileAliases(root: string): Promise<unknown> {
  return parseFrontmatter(await readConceptPage(root, CANONICAL_SLUG)).meta.aliases;
}

describe("concept aliases through the row seam", () => {
  it("stores the names a row-backed compile folded into the page", () =>
    withRowsStack("row-alias-write", async ({ root, harness }) => {
      await compileDocument(root, harness, ALPHA_FILE, SYNONYMS);

      expect(await conceptSlugs(harness)).toEqual([CANONICAL_SLUG]);
      expect(await storedAliases(harness, CANONICAL_SLUG)).toContain("Vector Database");
    }));

  it("reads the aliases back, so a later run keeps the names it resolved", () =>
    withRowsStack("row-alias-read", async ({ root, harness }) => {
      await compileDocument(root, harness, ALPHA_FILE, SYNONYMS);
      expect(await storedAliases(harness, CANONICAL_SLUG)).toContain("Vector Database");

      // The second document names the concept by its CANONICAL name only, so this run
      // folds nothing and re-derives no alias: `Vector Database` survives only if the
      // previous row is rendered back into the page the renderer re-reads -- which is
      // exactly what the file path does through the frontmatter of its existing page.
      await compileDocument(root, harness, "second.md", CANONICAL_ONLY);

      expect(await conceptSlugs(harness)).toEqual([CANONICAL_SLUG]);
      expect(await storedAliases(harness, CANONICAL_SLUG)).toContain("Vector Database");
    }));

  it("carries the same aliases a file-backed run of the same input does", () =>
    withRowsStack("row-alias-parity", async ({ root, harness }) => {
      await compileDocument(root, harness, ALPHA_FILE, SYNONYMS);
      const rowsFirstRun = await storedAliases(harness, CANONICAL_SLUG);
      await compileDocument(root, harness, "second.md", CANONICAL_ONLY);
      const rowsSecondRun = await storedAliases(harness, CANONICAL_SLUG);

      // The same corpus through the file-backed path: no Stack, so every seam is the
      // on-disk one and the alias lands in the page's frontmatter instead of a column.
      delete process.env.AKS_STACK_ID;
      stubNames(SYNONYMS);
      await compileAndReport(root);
      const filesFirstRun = await fileAliases(root);
      stubNames(CANONICAL_ONLY);
      await writeSource(root, "third.md", DOCUMENT);
      await compileAndReport(root);

      expect(rowsFirstRun).toEqual(filesFirstRun);
      expect(rowsSecondRun).toEqual(await fileAliases(root));
      expect(rowsSecondRun).toContain("Vector Database");
    }));
});
