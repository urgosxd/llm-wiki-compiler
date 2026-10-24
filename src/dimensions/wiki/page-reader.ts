/**
 * @file src/dimensions/wiki/page-reader.ts
 * @description The wiki dimension as a READER over Postgres instead of the
 * filesystem.
 *
 * ## Why this is a sibling of `reader.ts`, not a replacement
 *
 * `reader.ts` answers from a filesystem root and is what the product uses today.
 * W3.3 adds a database-backed answer, and W3.4 explicitly requires the file-backed
 * implementation to stay selectable, so the two coexist behind the same
 * `DimensionReader` contract and the caller picks. Rewriting `reader.ts` in place
 * would remove the local-first path that W3.4 exists to protect.
 *
 * Everything the two share — mapping, kind filtering, name tiering — lives in
 * `page-answer.ts` rather than being written twice. What remains here is only the
 * part that genuinely differs: obtaining the pages from Postgres.
 *
 * ## Why the tenant arrives as an option, not through the port
 *
 * `DimensionQuery` has no tenant field and is a frozen contract. The KG reader
 * already solved this the same way — `createKgReader({ stackId })` binds the stack
 * at construction — so this follows that precedent rather than inventing a second
 * convention. The consequence is honest: one reader instance serves exactly one
 * tenant, and a caller serving several constructs one per stack. That is cheaper
 * than threading a tenant through every call and it cannot be forgotten at a call
 * site, which is the failure mode that matters.
 *
 * ## What this reader does NOT answer
 *
 * Relationships, for the same reason `reader.ts` does not.
 *
 * Text search over page bodies is also absent, and deliberately. The filesystem
 * reader's chunk search runs through the embedding store, which is a separate
 * system W3 does not move. Returning an empty `chunks` array would read as
 * "nothing matched", so a text-only query reports `unavailable` instead.
 */

import type { Database } from "llmwiki-kg";
import type {
  DimensionAnswer,
  DimensionQuery,
  DimensionReader,
  GraphReadResult,
} from "../read-types.js";
import {
  DEFAULT_PAGE_LIMIT,
  answerFromPages,
  resolvePageByName,
  scopeByKinds,
} from "./page-answer.js";
import { listStoredPages } from "./page-store.js";

/** What a database-backed wiki reader needs to exist. */
export interface WikiPageReaderOptions {
  /** The tenant whose pages this reader answers for. */
  readonly stackId: string;
  /** Database handle; the pooled one in production, a test's own in tests. */
  readonly db: Database;
}

/**
 * Answer a request for one page by title.
 *
 * @param options - Tenant and database handle.
 * @param name - Requested title.
 * @param kinds - Optional directory restriction.
 * @returns The single match, or `not_found`.
 */
async function readByName(
  options: WikiPageReaderOptions,
  name: string,
  kinds: readonly string[] | undefined,
): Promise<GraphReadResult<DimensionAnswer>> {
  const all = await listStoredPages(options.db, options.stackId, Number.MAX_SAFE_INTEGER);
  const page = resolvePageByName(scopeByKinds(all, kinds), name);
  if (page === undefined) {
    return { ok: false, error: { code: "not_found", message: `No wiki page named '${name}'` } };
  }
  return { ok: true, value: answerFromPages([page]) };
}

/**
 * Answer one question against the stored wiki.
 *
 * @param options - Tenant and database handle.
 * @param query - What to look for.
 * @returns The answer, or a coded failure.
 */
async function readStoredWiki(
  options: WikiPageReaderOptions,
  query: DimensionQuery,
): Promise<GraphReadResult<DimensionAnswer>> {
  // A text-only query has no answer here: page bodies are not indexed for search
  // in this schema yet, and an empty result would be indistinguishable from
  // "nothing matched". Saying `unavailable` is the honest report.
  const hasListingSignal =
    query.name !== undefined || query.text === undefined || query.text.trim() === "";
  if (!hasListingSignal) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: "The stored wiki has no text search; it answers listings and name lookups",
      },
    };
  }

  if (query.name !== undefined && query.name.trim() !== "") {
    return readByName(options, query.name, query.kinds);
  }

  const listed = await listStoredPages(
    options.db,
    options.stackId,
    query.limit ?? DEFAULT_PAGE_LIMIT,
  );
  return { ok: true, value: answerFromPages(scopeByKinds(listed, query.kinds)) };
}

/**
 * Build the wiki dimension's database-backed reader.
 *
 * @param options - Tenant binding and database handle.
 * @returns A reader bound to that tenant.
 */
export function createWikiPageReader(options: WikiPageReaderOptions): DimensionReader {
  return {
    name: "wiki",
    read: (query: DimensionQuery) => readStoredWiki(options, query),
  };
}
