/**
 * @file test/dimensions/row-page-round-trip.test.ts
 * @description A row page's stored body survives `row -> markdown -> row` unchanged (S3, S7).
 *
 * ## The defect this file pins
 *
 * `wiki.pages` stores a page's PROSE in a column, and the only way a row becomes
 * markdown is `renderPageMarkdown` (`src/dimensions/wiki/page-scan-source.ts`), which
 * rebuilds frontmatter from the columns and then appends the body. Reading a page back
 * runs the inverse, `parseFrontmatter` (`src/utils/markdown.ts`), which strips the
 * frontmatter block AND the single newline that terminates its closing fence.
 *
 * A page written by the compiler is `${frontmatter}\n\n${prose}\n`
 * (`src/compiler/page-renderer.ts`), so a parsed body ALREADY begins with one newline:
 * that is the blank line separating frontmatter from prose, and the file path's body
 * carries it too. A render that re-added the separator therefore handed the parser one
 * newline more than it wrote -- and since the resolver stores the rendered markdown back
 * whenever it adds a link (`rewritePage`), the stored body gained one leading blank line
 * per rewrite, forever.
 *
 * ## What is asserted, and why through these primitives
 *
 * The trip is driven by the two functions the compile path itself uses for it: the row
 * content source (`createPageContentSource`, the seam `readWikiPageFrom` asks) to render,
 * and the row write sink (`createPageWriteSink`) to store the result. `rewritePage`
 * writes exactly `content` with its body substituted back, so storing `content` verbatim
 * is that write with nothing changed.
 *
 * The stored value is read from the `body` COLUMN rather than through the reader, because
 * a reader and a writer broken in the same direction would still agree with each other.
 *
 * The body is also asserted against its EXACT bytes, leading newline included, so this
 * file fails if the convention drifts in either direction. Cross-BACKEND equality -- that
 * a row-backed page and a file-backed page of the same corpus hold the same body -- is
 * asserted in `row-page-curated-links.test.ts`'s parity case, which compares the two
 * bodies and their anchor windows with no trimming at all.
 */

import { describe, expect, it } from "vitest";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { getStoredPage } from "../../packages/wiki/src/dimensions/wiki/page-store.js";
import { createPageContentSource } from "../../packages/wiki/src/dimensions/wiki/page-scan-source.js";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { saveSourceDocument } from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { extractionAnswer, stubCompileProvider } from "../fixtures/compile-provider.js";
import { writeSource } from "../fixtures/curated-scenario.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";

/** Source filename, which is also the page's citation identity. */
const SOURCE_FILE = "alpha.md";

/** The one concept the source is extracted into. */
const TITLE = "Alpha Topic";

/** The slug that title is published under. */
const SLUG = "alpha-topic";

/** The prose the run writes, padded on neither side -- the renderer adds the framing. */
const BODY = "Alpha Topic stores vectors in a pgvector store. ^[alpha.md:1-1]";

/**
 * The body a compiled page stores, EXACTLY: the newline that followed the closing fence
 * (which the parser leaves in the body) plus the prose plus the renderer's final newline.
 */
const STORED_BODY = `\n${BODY}\n`;

/** Source text the extraction stub answers for. */
const DOCUMENT = "# Alpha\n\nAlpha describes the store.\n";

/**
 * Ingest the source into the Stack and leave the same bytes on disk, then compile.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack.
 */
async function compileOnce(root: string, harness: KgPostgresHarness): Promise<void> {
  await saveSourceDocument(harness.db, harness.stackId, {
    title: "alpha", document: DOCUMENT, source: SOURCE_FILE,
  });
  await writeSource(root, SOURCE_FILE, DOCUMENT);
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  stubCompileProvider({
    extraction: () => extractionAnswer([TITLE]),
    body: () => BODY,
  });
  await compileAndReport(root);
}

/**
 * The page's stored prose, read from the `body` column.
 *
 * @param harness - The suite's Stack.
 * @returns The stored body, or `""` when the row is missing.
 */
async function storedBody(harness: KgPostgresHarness): Promise<string> {
  const page = await getStoredPage(harness.db, harness.stackId, "concepts", SLUG);
  return page?.body ?? "";
}

/**
 * One `row -> markdown -> row` trip, through the primitives the compile path uses.
 *
 * Render the row exactly as `readWikiPageFrom` does, then store that markdown exactly as
 * the page sink does. `rewritePage` performs the same pair when it patches a body inside
 * the rendered text, so a difference introduced here is a difference every rewrite pays.
 *
 * @param harness - The suite's Stack.
 */
async function roundTrip(harness: KgPostgresHarness): Promise<void> {
  const rendered = await createPageContentSource(harness.db, harness.stackId)
    .read("concepts", SLUG);
  await createPageWriteSink(harness.db, harness.stackId)({
    directory: "concepts", slug: SLUG, body: rendered ?? "",
  });
}

describe("the row-to-markdown round trip", () => {
  it("keeps the stored body byte-identical across two round trips", () =>
    withRowsStack("row-round-trip-idempotent", async ({ root, harness }) => {
      await compileOnce(root, harness);
      const first = await storedBody(harness);
      expect(first).toBe(STORED_BODY);

      await roundTrip(harness);
      const second = await storedBody(harness);
      await roundTrip(harness);
      const third = await storedBody(harness);

      // A body that grows per run is an oscillation bug, not a formatting detail.
      expect(second).toBe(first);
      expect(third).toBe(first);
    }));
});
