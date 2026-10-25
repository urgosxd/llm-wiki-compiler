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
import { buildPage, type Page, type PageDirectory } from "../../pages/list.js";
import { parseFrontmatter } from "../../utils/markdown.js";
import { upsertStoredPage } from "./page-store.js";

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
