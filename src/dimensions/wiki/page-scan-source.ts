/**
 * Serve the wiki page SCAN shape from rows.
 *
 * ## Why this shape and not `Page`
 *
 * Several consumers (`status`, the index builder, the refresh planner) read pages
 * through `scanWikiPages`, which returns `{ slug, meta }` -- the parsed frontmatter,
 * not a typed page. Rebuilding that from a `Page` would mean re-serialising metadata
 * a row already stores as columns, and the inverse mapping is where these would
 * drift. The adapter therefore produces the shape the consumers actually ask for.
 *
 * ## Why the handle is typed structurally
 *
 * This module reaches the DTS graph through `compiler-cli`, which cannot resolve the
 * `llmwiki-kg` package -- the same limitation documented at `compiler/index.ts`. A
 * nominal `Database` import breaks `tsup`'s declaration build, and a failed build
 * CLEARS `.llmwiki/build-stamp.json`, which wedges every subsequent test run. The
 * parameter is therefore declared by the only method this module calls.
 *
 * ## Why `meta` is reconstructed rather than stored
 *
 * `wiki.pages` keeps `title`, `summary`, `tags`, `orphaned` and `archived` as
 * columns; `meta` is just those columns under the names the file's frontmatter
 * parser produces. Building it here keeps one translation in one place instead of
 * making every consumer know both vocabularies.
 */

import { listStoredPages } from "./page-store.js";
import type { Page, PageDirectory } from "../../pages/list.js";

/** A page as `scanWikiPages` reports it: identity plus parsed frontmatter. */
export interface ScannedPageShape {
  slug: string;
  meta: Record<string, unknown>;
}

/** A page as `collectPageSummaries` reports it. */
export interface PageSummaryShape {
  title: string;
  slug: string;
  summary: string;
}

/**
 * The only capability this module needs from the database handle.
 *
 * Declared locally as `unknown` on purpose. `Parameters<typeof listStoredPages>[0]`
 * would pull `page-store.ts`'s real client type into the declaration graph, and that
 * type names `llmwiki-kg`, which `tsup`'s DTS build cannot resolve from here. The
 * real check happens at the CALL SITE, where `listStoredPages` still demands its own
 * parameter type -- so nothing is actually loosened.
 */
type PageStoreHandle = unknown;

/** Where the scan-shaped reads come from. */
export interface PageScanSource {
  /**
   * Every page in one wiki directory, in the scan's shape.
   *
   * @param directory - `concepts` or `queries`.
   * @returns Pages with parsed frontmatter, archived ones included (the file scan
   *   does not filter, so neither may this).
   */
  scan(directory: PageDirectory): Promise<ScannedPageShape[]>;
}

/**
 * Build the row-backed scan source for one Stack.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @returns A source for `status`, the index builder and the refresh planner.
 */
export function createPageScanSource(
  db: PageStoreHandle,
  stackId: string,
): PageScanSource {
  return {
    scan: async (directory) => {
      const pages = await listStoredPages(db as never, stackId, Number.MAX_SAFE_INTEGER);
      return pages
        .filter((page) => page.pageDirectory === directory)
        .map(toScannedShape);
    },
  };
}

/**
 * Translate a stored page into the scan shape.
 *
 * `orphaned` and `archived` are always present, never omitted, because the file
 * frontmatter parser reports them as `undefined` when absent and every caller tests
 * them for truthiness -- a missing key and a `false` value read the same there.
 *
 * @param page - A page from the row store.
 * @returns Its scan shape.
 */
function toScannedShape(page: Page): ScannedPageShape {
  const meta: Record<string, unknown> = {
    title: page.title,
    summary: page.summary,
    tags: page.tags,
    orphaned: page.orphaned,
    archived: page.archived,
  };
  if (page.createdAt !== undefined) meta.createdAt = page.createdAt;
  if (page.updatedAt !== undefined) meta.updatedAt = page.updatedAt;
  return { slug: page.slug, meta };
}

/**
 * The `collectPageSummaries` projection, applied to a scan source.
 *
 * Mirrors `collectPageSummaries` exactly: a title is required and an orphaned page
 * is excluded. Kept beside the source so the two filter rules cannot diverge.
 *
 * @param scanned - Pages in the scan shape.
 * @returns Summaries as the index builder and status expect them.
 */
export function summarizeScanned(scanned: ScannedPageShape[]): PageSummaryShape[] {
  return scanned
    .filter(({ meta }) => meta.title && typeof meta.title === "string" && !meta.orphaned)
    .map(({ slug, meta }) => ({
      title: meta.title as string,
      slug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
    }));
}
