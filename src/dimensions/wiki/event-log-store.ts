/**
 * @file src/dimensions/wiki/event-log-store.ts
 * @description The append-only, hash-chained EVENT log, as rows.
 *
 * ## The property that must survive
 *
 * Every event carries `prevHash` (the digest of the record before it) and `checksum`
 * (its own). Together they make the log tamper-EVIDENT: a flipped byte breaks that
 * record's checksum, a deleted record breaks the next one's link, and a reordered
 * pair breaks both. The file format got this almost for free from line order.
 *
 * ## What replaces line order, and why it is better
 *
 * A table has no inherent order, so `seq` carries it: a per-Stack, gapless counter.
 * The chain rule is unchanged — `checksum(n)` folds in `prevHash = checksum(n-1)` —
 * but two properties improve:
 *
 *   1. **No forking.** Two hosts appending to one Stack's FILE each hold their own
 *      copy and diverge silently. `seq` is allocated as `max(seq)+1` inside a
 *      transaction holding the Stack's advisory lock, so the second appender blocks
 *      until the first commits and can only see a consistent tail.
 *   2. **No torn tail.** A file can end mid-line after a crash; a transaction either
 *      committed the row or did not.
 *
 * The head anchor at `.llmwiki/events.head` becomes unnecessary, which is worth
 * stating because it was load-bearing: the file needed it to distinguish "a record
 * the head never sealed" from "a committed record". A committed row IS the seal.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { ulid } from "../../relations/ulid.js";
import { eventChecksum, type EventChecksumInput } from "../../events/store-record.js";
import { GENESIS_PREV_HASH } from "../../events/types.js";
import type { EventContent, EventRecord } from "../../events/types.js";

/** One `event_log` row as Postgres returns it. */
interface EventRow extends Record<string, unknown> {
  readonly seq: string | number;
  readonly event_id: string;
  readonly event_type: string;
  readonly origin: string;
  readonly payload: unknown;
  readonly decision: string | null;
  readonly operation_binding: unknown;
  readonly prev_hash: string;
  readonly checksum: string;
  readonly at: string | Date;
}

/**
 * Rebuild the `EventRecord` shape the readers already understand.
 *
 * @param row - An `event_log` row.
 * @returns The equivalent record, `seq` included as a non-enumerable extra.
 */
function toEventRecord(row: EventRow): EventRecord & { seq: number } {
  const content: EventContent = {
    id: row.event_id as EventContent["id"],
    type: row.event_type as EventContent["type"],
    origin: row.origin,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    ...(row.decision === null ? {} : { decision: row.decision }),
    ...(row.operation_binding === null
      ? {}
      : { operationBinding: row.operation_binding as EventContent["operationBinding"] }),
    at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString(),
  };
  return {
    ...content,
    prevHash: row.prev_hash,
    checksum: row.checksum,
    seq: Number(row.seq),
  };
}

/**
 * Read one Stack's chain, in order.
 *
 * Ordered by `seq` because that IS the chain: a reader that reordered these rows
 * would report every link as broken.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose log to read.
 * @returns The records, oldest first; empty for a Stack that logged nothing.
 */
export async function readEventLog(db: Database, stackId: string): Promise<Array<EventRecord & { seq: number }>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<EventRow>(sql`
      select seq, event_id, event_type, origin, payload, decision,
             operation_binding, prev_hash, checksum, at
      from wiki.event_log
      where stack_id = ${stackId}
      order by seq asc
    `);
    return rows.map(toEventRecord);
  });
}

/**
 * Append one event to a Stack's chain, allocating its `seq` and linking its hash.
 *
 * ## Why the allocation and the insert share one transaction
 *
 * `max(seq)+1` is only safe if nothing can insert a competing `seq` between reading
 * the maximum and writing the row. The advisory lock is taken FIRST, inside the same
 * transaction, so a second appender waits rather than reading the same maximum. The
 * primary key on `(stack_id, seq)` is the backstop: if this ever raced anyway, the
 * second insert would fail loudly instead of silently forking the chain.
 *
 * ## Why `prevHash` comes from the tail row, not from a cached value
 *
 * A cache would have to be invalidated by every appender, including other processes.
 * Reading the tail's checksum inside the lock is one indexed lookup and cannot be
 * stale.
 *
 * @param db - Database handle.
 * @param stackId - The Stack to append to.
 * @param content - The event content, without `id`, `prevHash` or `checksum`.
 * @returns The appended record, with its allocated `seq`.
 */
export async function appendEventRow(
  db: Database,
  stackId: string,
  content: Omit<EventContent, "id" | "at"> & { at?: string },
): Promise<EventRecord & { seq: number }> {
  const at = content.at ?? new Date().toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    // Serialize appenders on this Stack. Two-int form, matching the lock module, so
    // unrelated tooling sharing the database cannot collide by accident.
    await tx.execute(sql`select pg_advisory_xact_lock(19535, hashtext(${stackId}))`);

    const tail = await tx.execute<{ seq: string | number; checksum: string }>(sql`
      select seq, checksum from wiki.event_log
      where stack_id = ${stackId}
      order by seq desc limit 1
    `);
    const prevHash = tail[0]?.checksum ?? GENESIS_PREV_HASH;
    const seq = tail[0] === undefined ? 1 : Number(tail[0].seq) + 1;

    const record: Omit<EventContent, "id"> & { id: EventContent["id"] } = {
      ...content,
      id: ulid() as EventContent["id"],
      at,
    };
    // `prevHash` is part of the checksummed input, which is what chains the records:
    // changing an earlier record changes this one's checksum too.
    const checksum = eventChecksum({ ...record, prevHash } as EventChecksumInput);

    await tx.execute(sql`
      insert into wiki.event_log
        (stack_id, seq, event_id, event_type, origin, payload, decision,
         operation_binding, prev_hash, checksum, at)
      values (
        ${stackId}, ${seq}, ${record.id}, ${record.type}, ${record.origin},
        ${JSON.stringify(record.payload)}::jsonb,
        ${record.decision ?? null},
        ${record.operationBinding === undefined
          ? null
          : JSON.stringify(record.operationBinding)}::jsonb,
        ${prevHash}, ${checksum}, ${at}::timestamptz
      )
    `);

    return { ...record, prevHash, checksum, seq } as EventRecord & { seq: number };
  });
}
