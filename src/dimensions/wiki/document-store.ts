/**
 * @file src/dimensions/wiki/document-store.ts
 * @description One small JSON document per Stack, for either of the two tables that hold one.
 *
 * ## Why this exists as a shared helper
 *
 * `wiki.profile` and `wiki.template_lock` are the same row shape by accident of having the
 * same requirement: a single validated document, content-addressed by a digest, replaced
 * rather than accumulated, one row per Stack. Writing the upsert and the read twice meant
 * two copies of the same RLS-binding call and the same `on conflict` clause -- and a
 * duplicate bug is what duplication buys.
 *
 * ## Why a table name is passed instead of a table object
 *
 * The two reads differ ONLY in which table they name, and SQL identifiers cannot be bound
 * as parameters. Rather than build the statement from a caller-supplied string -- an
 * injection surface for a function that is otherwise pure plumbing -- each module passes a
 * constant it owns. The table list is therefore closed at compile time, and a reviewer can
 * see the whole set by searching for this module's callers.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";

/** The tables that hold exactly one document per Stack. */
export type DocumentTable = "profile" | "template_lock";

/** One Stack's stored document and its recorded digest. */
export interface StoredDocumentRow {
  /** The document as stored, unparsed. */
  readonly document: unknown;
  /** The digest recorded at write time. */
  readonly digest: string;
}

/**
 * Store one document, replacing whatever was there.
 *
 * An upsert because these are REPLACEMENTS of a single value, not accumulations: two
 * profiles or two lock versions for one Stack is not a state either backend ever had.
 *
 * @param db - Database handle.
 * @param table - Which single-document table this Stack's row belongs in.
 * @param stackId - The Stack whose document this is.
 * @param document - The validated document.
 * @param digest - Its content address.
 */
export async function saveDocumentRow(
  db: Database,
  table: DocumentTable,
  stackId: string,
  document: unknown,
  digest: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    // One branch per table rather than an interpolated identifier: the set is closed here,
    // at compile time, instead of being assembled from a caller-supplied string.
    const statement = table === "profile"
      ? sql`insert into wiki.profile (stack_id, document, digest)
            values (${stackId}, ${JSON.stringify(document)}::jsonb, ${digest})
            on conflict (stack_id) do update set
              document = excluded.document, digest = excluded.digest, updated_at = now()`
      : sql`insert into wiki.template_lock (stack_id, document, digest)
            values (${stackId}, ${JSON.stringify(document)}::jsonb, ${digest})
            on conflict (stack_id) do update set
              document = excluded.document, digest = excluded.digest, updated_at = now()`;
    await tx.execute(statement);
  });
}

/**
 * Read one Stack's document, or undefined when it has none.
 *
 * Undefined means "nothing stored", which both callers must keep distinct from a fault or
 * a malformed value: the profile yields the built-in default, and the template lock reports
 * `absent` rather than `malformed`.
 *
 * @param db - Database handle.
 * @param table - Which single-document table to read.
 * @param stackId - The Stack whose document to read.
 * @returns The stored document and digest, or undefined when absent.
 */
export async function readDocumentRow(
  db: Database,
  table: DocumentTable,
  stackId: string,
): Promise<StoredDocumentRow | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = table === "profile"
      ? await tx.execute<{ document: unknown; digest: string }>(
        sql`select document, digest from wiki.profile where stack_id = ${stackId}`)
      : await tx.execute<{ document: unknown; digest: string }>(
        sql`select document, digest from wiki.template_lock where stack_id = ${stackId}`);
    const row = rows[0];
    return row === undefined ? undefined : { document: row.document, digest: row.digest };
  });
}
