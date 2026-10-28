/**
 * Write compiled wiki pages as rows instead of files.
 *
 * ## Why the same parser as the file path
 *
 * A page reaches storage as raw markdown, frontmatter included: title, summary,
 * tags, status flags and body all live in those bytes. The file path derives a
 * `Page` from them with `buildPage`; this sink calls the SAME function. Re-deriving
 * the shape here would let the row and the file describe different pages from
 * identical input, and the difference would only show up as a query answering with
 * a stale title or a missing tag.
 *
 * ## What it deliberately does not do
 *
 * It does not touch the journal, the content floor, or the confinement checks. Those
 * run in the caller, BEFORE this is reached, and they are about the bytes being
 * written rather than about where the bytes are stored. A row has no path to escape
 * and no pre-state to record, so re-running them here would be ceremony without a
 * guarantee behind it.
 */

import type { Database } from "llmwiki-kg";
import {
  buildPage,
  type Page,
  type PageDirectory,
  type PageListingSource,
} from "../../pages/list.js";
import { parseFrontmatter } from "../../utils/markdown.js";
import { deleteStoredPage, getStoredPage, listStoredPages, upsertStoredPage } from "./page-store.js";
import type { PageRemover } from "../../trust/page-apply.js";

/**
 * Where compiled pages are written.
 *
 * Shaped as a function so the executor can take it as a session option rather than
 * importing a database: the executor is on the trust path and must stay usable with
 * no database at all, which is how every existing caller runs today.
 */
export type PageWriteSink = (mutation: PageWriteRequest) => Promise<void>;

/** One page to store: its identity and the markdown it was rendered from. */
export interface PageWriteRequest {
  /** Wiki namespace, e.g. `concepts`. */
  directory: string;
  /** Bare slug stem, no directory and no extension. */
  slug: string;
  /** Full markdown (frontmatter + prose) exactly as it would be written to disk. */
  body: string;
}

/**
 * Build a row-writing sink for one Stack.
 *
 * @param db - Database handle.
 * @param stackId - Stack that owns these pages.
 * @returns A sink the executor can call instead of writing a file.
 */
export function createPageWriteSink(db: Database, stackId: string): PageWriteSink {
  return async (request) => {
    await upsertStoredPage(db, stackId, toPage(request));
  };
}

/**
 * Build a row DELETING sink for one Stack.
 *
 * Paired with {@link createPageWriteSink} rather than folded into it: the executor
 * takes a writer as a bare function at five call sites, and a store may support
 * writing without supporting deletion. Supplying this is what makes a `delete`
 * mutation reach the row instead of unlink-ing a file that does not exist, which is
 * a complete no-op in a Stack-backed project.
 *
 * @param db - Database handle.
 * @param stackId - Stack that owns these pages.
 * @returns A remover the executor can call instead of unlinking a file.
 */
export function createPageRemoveSink(db: Database, stackId: string): PageRemover {
  return async (request) => {
    await deleteStoredPage(
      db, stackId, request.directory as PageDirectory, request.slug,
    );
  };
}

/**
 * Turn a rendered page into the `Page` shape the row store expects.
 *
 * Exported for the tests that pin the row/file parity: with the same `request` and
 * the same file bytes, both paths must produce the same object.
 *
 * @param request - Page identity and markdown.
 * @returns The parsed page, body included (a row always stores its body).
 */
export function toPage(request: PageWriteRequest): Page {
  const { meta, body } = parseFrontmatter(request.body);
  return buildPage(
    // The directory is a wiki namespace, which is exactly what `PageDirectory` names.
    request.directory as PageDirectory,
    request.slug,
    meta as Record<string, unknown>,
    body,
    true,
  );
}

/**
 * Read pages back from the table, for the listing API to use instead of a directory.
 *
 * Only `concepts` and `queries` are wiki page directories; a row in any other
 * `page_directory` (a profile entity type, for instance) is not a wiki page and is
 * excluded here rather than surfacing as an unknown directory.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose pages to read.
 * @returns A listing source for {@link listPages} and {@link getPage}.
 */
export function createPageListingSource(db: Database, stackId: string): PageListingSource {
  return {
    list: async () => {
      // No limit: `listPages` owns pagination, and a source that truncated would
      // make `total` and the cursor describe a subset it never admitted to.
      const pages = await listStoredPages(db, stackId, Number.MAX_SAFE_INTEGER);
      return pages.filter((page) => isWikiPageDirectory(page.pageDirectory));
    },
    get: async (pageDirectory, slug) => {
      const page = await getStoredPage(db, stackId, pageDirectory, slug);
      return page ?? null;
    },
  };
}

/**
 * Whether a directory names a wiki page namespace.
 *
 * @param directory - The row's `page_directory`.
 * @returns True for `concepts` and `queries`.
 */
function isWikiPageDirectory(directory: string): boolean {
  return directory === "concepts" || directory === "queries";
}
