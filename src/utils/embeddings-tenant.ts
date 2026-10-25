/**
 * @file src/utils/embeddings-tenant.ts
 * @description The two primitives the embedding read and write paths both need.
 *
 * ## Why this file exists
 *
 * Tenant binding and page-id splitting are needed by BOTH halves of the embedding
 * tables: the reader binds the tenant and decomposes a `pageId` to reassemble
 * records, and the writer binds the tenant and decomposes a `pageId` to key rows.
 * Keeping them in the reader made the writer import the reader, while the reader
 * already imported the writer for its sink -- a cycle.
 *
 * It was a real cycle, not a lint artefact: loading either module first would have
 * seen the other half-initialised. Hoisting the shared primitives is what makes the
 * dependency a line instead of a loop.
 */
import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { parseQualifiedPageId, type PageId } from "./page-id.js";

/**
 * Bind the tenant on this connection for the duration of the transaction.
 *
 * `set_config(..., is_local = true)` is the parameterised form of `SET LOCAL`, so
 * the binding ends with the transaction and cannot leak onto the next user of a
 * pooled connection. Without it the tenant policy matches nothing, so a read
 * returns zero rows for a Stack that genuinely has vectors, and a write is refused
 * with "new row violates row-level security policy".
 *
 * @param db - Connection about to run a tenanted statement.
 * @param stackId - Stack whose rows are being read or written.
 */
export async function bindStack(db: Database, stackId: string): Promise<void> {
  await db.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
}

/**
 * Split a qualified page id into the `(page_directory, slug)` pair the tables key on.
 *
 * `wiki.pages` is keyed by `(stack_id, page_directory, slug)`, which is exactly a
 * `PageId` (`<namespace>/<page-part>`) decomposed. Returning null for a malformed id
 * rather than throwing keeps one bad entry from making the whole store unreadable,
 * which is the behaviour the file loader already had.
 *
 * @param pageId - Qualified page identity.
 * @returns The directory and slug, or null when the id does not parse.
 */
export function splitPageId(pageId: PageId): { pageDirectory: string; slug: string } | null {
  const parsed = parseQualifiedPageId(pageId);
  if (parsed === null) return null;
  return { pageDirectory: parsed.namespace, slug: parsed.pagePart };
}
