/**
 * @file src/dimensions/wiki/activity-log-store.ts
 * @description The append-only activity journal (`log.md`), as rows.
 *
 * ## What the file was, and what survives
 *
 * `log.md` is a chronological journal: one heading per operation, blank-line
 * separated, optionally with a `- detail` bullet body. It has three writers (ingest,
 * query, compile) and two consumers (the OKF export's `parseLlmwikiLog`, and a human
 * running `grep "^## \[" log.md | tail -5`).
 *
 * A row keeps the FIELDS and re-renders the markdown on read, through the same
 * `formatLogEntry` the file writer uses. That is deliberate: the OKF bundle parses
 * headings, so the rendered text is a contract. Storing the rendered string would
 * make it a cache of a formatting decision and hide which part is data; storing the
 * fields and rendering once keeps both backends byte-identical from the same facts.
 *
 * ## Why `seq` and not just `at`
 *
 * The file renders timestamp to SECOND precision, so two entries can legitimately
 * share a heading timestamp. A file breaks that tie by byte position; a table needs
 * the order stated. `seq` is per-Stack and gapless, allocated as `max(seq)+1` inside
 * the transaction holding the Stack's advisory lock, so a second appender waits
 * instead of reading the same maximum and forking the history.
 *
 * ## Append-only is enforced by the grant, not by omission
 *
 * The migration grants `select, insert` and revokes `update, delete`. An RLS policy
 * is permissive and additive, so simply not writing a DELETE policy does NOT deny
 * deletion — it only stops other tenants. Verified: as `llmwiki_app`, UPDATE and
 * DELETE both fail with "permission denied".
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { toArrayLiteral } from "./sql-array.js";

/** One journal entry, in the shape both backends render from. */
export interface JournalEntry {
  /** Short operation tag, e.g. `ingest`, `compile`, `query`. */
  readonly operation: string;
  /** Heading detail, already sanitized by the caller. */
  readonly description: string;
  /** Optional `- ` bullet body lines, in order. */
  readonly details: readonly string[];
  /** When the operation happened. Rendered to second precision. */
  readonly at: Date;
}

/** One `wiki.activity_log` row as Postgres returns it. */
interface JournalRow extends Record<string, unknown> {
  readonly operation: string;
  readonly description: string;
  readonly details: string[] | null;
  readonly at: Date | string;
}

/**
 * Append one entry to a Stack's journal.
 *
 * @param db - Database handle.
 * @param stackId - The Stack this entry belongs to.
 * @param entry - The operation, description, details and timestamp.
 * @returns The `seq` the entry was allocated.
 */
export async function appendJournalEntry(
  db: Database,
  stackId: string,
  entry: JournalEntry,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    // Serialize appenders on this Stack: `max(seq)+1` is only safe if nothing can
    // insert between the read and the write.
    await tx.execute(sql`select pg_advisory_xact_lock(19535, hashtext(${stackId}))`);
    const next = await tx.execute<{ seq: string | number }>(sql`
      select coalesce(max(seq), 0) + 1 as seq
      from wiki.activity_log where stack_id = ${stackId}
    `);
    const seq = Number(next[0]?.seq ?? 1);
    await tx.execute(sql`
      insert into wiki.activity_log (stack_id, seq, operation, description, details, at)
      values (${stackId}, ${seq}, ${entry.operation}, ${entry.description},
              ${toArrayLiteral(entry.details)}::text[], ${entry.at.toISOString()})
    `);
    return seq;
  });
}

/**
 * Read a Stack's journal, newest entry last.
 *
 * Ordered by `seq` rather than `at` because the file's order WAS byte position, and
 * two entries can share a rendered timestamp. A caller that sorts by date would
 * reorder history the moment two operations landed in the same second.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose journal to read.
 * @returns Every entry in the order it was appended.
 */
export async function readJournalEntries(
  db: Database,
  stackId: string,
): Promise<JournalEntry[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<JournalRow>(sql`
      select operation, description, details, at
      from wiki.activity_log
      where stack_id = ${stackId}
      order by seq asc
    `);
    return rows.map((row) => ({
      operation: row.operation,
      description: row.description,
      details: row.details ?? [],
      at: row.at instanceof Date ? row.at : new Date(row.at),
    }));
  });
}
