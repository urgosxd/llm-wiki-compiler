/**
 * @file src/dimensions/outbox.ts
 * @description Durable record of a two-dimension ingest, written before the
 * commit so an interrupted run can be finished later.
 *
 * ## Why an outbox rather than a plain transaction
 *
 * The two dimensions cannot share a transaction: the wiki writes rows through its
 * own tenant-bound transaction and the graph opens its own connection. No `BEGIN`
 * spans both, so a process crash between them is a real state a single transaction
 * cannot prevent. The outbox is what makes that state **recoverable** instead of
 * corrupt:
 *
 *   1. `pending` is written **before** any dimension commits. It names every
 *      dimension and the idempotency key each will use.
 *   2. Each dimension commits and records its key back into the record.
 *   3. `committed` is written once every dimension succeeded.
 *
 * A record still `pending` on the next run is unfinished work: the reconciler
 * re-runs the dimensions that did not record a key. Because each dimension's commit
 * is idempotent under its key, replay cannot double-write.
 *
 * ## Why rows and not `.llmwiki/dimensions/outbox/*.json`
 *
 * The file outbox was scoped to a PROJECT: one directory inside each checkout. That
 * was right while an ingest belonged to a directory, and wrong once the compiled
 * pages became rows. An ingest now belongs to a STACK -- the one both dimensions are
 * bound to -- so the recovery record lives where the stack lives.
 *
 * This is not a tidiness argument. Measured before the move: one database held 412
 * stacks and no column anywhere identified a project, so a project-scoped record had
 * no honest place to sit, and two projects sharing that database would have listed
 * and reconciled each other's interrupted ingests. `stack_id` also puts the record
 * under the same RLS policy as every other tenanted table, so "the pending ingests of
 * THIS stack" is a query rather than a filter someone must remember to write.
 *
 * ## What is preserved from the file version
 *
 * The record still carries `document` and `body`, because a reconciler that runs on
 * the next boot has no network, no source file, and no caller to ask. Durability now
 * comes from the transaction that writes the row rather than from `atomicWrite`:
 * a committed insert is a committed record, and a rolled-back one leaves nothing.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import type { DimensionName } from "./types.js";

/** Lifecycle of one ingest record. */
export type OutboxStatus = "pending" | "committed";

/** What one dimension did, or is expected to do, for one ingest. */
export interface OutboxDimensionEntry {
  /** Which dimension. */
  readonly name: DimensionName;
  /**
   * Idempotency key once the dimension committed, or `null` while it has not.
   * A record whose entry is still `null` is work the reconciler must retry.
   */
  readonly idempotencyKey: string | null;
}

/** One durable ingest record. */
export interface OutboxRecord {
  /** Schema version, so a future format change is detectable. */
  readonly version: 1;
  /** Stable id; primary key of the row. */
  readonly ingestId: string;
  /** Source identity the dimensions were given. */
  readonly source: string;
  /** Human-readable title. */
  readonly title: string;
  /** Document body, retained so a replay needs no re-fetch. */
  readonly document: string;
  /** Extracted body text (no frontmatter), retained for the graph replay. */
  readonly body: string;
  /** Lifecycle status. */
  readonly status: OutboxStatus;
  /** Per-dimension progress. */
  readonly dimensions: readonly OutboxDimensionEntry[];
  /** ISO timestamp of creation. */
  readonly createdAt: string;
}

/** Length of the random suffix appended to a minted ingest id. */
const INGEST_ID_RANDOM_CHARS = 8;

/** Columns the record reader selects, in one place so the two queries agree. */
const RECORD_COLUMNS = `
  ingest_id as "ingestId",
  source,
  title,
  document,
  body,
  status,
  dimensions,
  created_at as "createdAt"
`;

/**
 * One row as the reader shapes it, before it becomes an `OutboxRecord`.
 *
 * An index signature is required by the driver's `execute<T>` constraint, which
 * asks for a plain record rather than a closed interface.
 */
interface RecordRow extends Record<string, unknown> {
  readonly ingestId: string;
  readonly source: string;
  readonly title: string;
  readonly document: string;
  readonly body: string;
  readonly status: string;
  readonly dimensions: unknown;
  readonly createdAt: Date | string;
}

/**
 * Bind the tenant on this connection for the duration of the transaction.
 *
 * Uses `set_config(..., is_local = true)`, the parameterised form of SET LOCAL, so
 * the binding ends with the transaction and cannot leak onto a pooled connection.
 *
 * @param db - Connection about to run a tenanted statement.
 * @param stackId - Stack the statement operates on.
 */
async function bindStack(db: Database, stackId: string): Promise<void> {
  await db.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
}

/** Mint a unique ingest id. */
export function mintIngestId(now: number = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 2 + INGEST_ID_RANDOM_CHARS);
  return `${now}-${random}`;
}

/**
 * Persist a record, replacing any existing copy.
 *
 * The insert is the durability boundary that `atomicWrite` used to be: a committed
 * statement is a durable record and a rolled-back one leaves nothing behind, so
 * there is no torn half-record for the reconciler to misread.
 *
 * @param db - Tenant-bound database handle; RLS requires `stackId` to match.
 * @param stackId - Stack this ingest belongs to.
 * @param record - Record to persist.
 */
export async function saveRecord(
  db: Database,
  stackId: string,
  record: OutboxRecord,
): Promise<void> {
  // The insert must satisfy the tenant policy, and the policy reads `app.stack_id`.
  // Nothing upstream sets it on this connection, so the write would fail with
  // "new row violates row-level security policy" the moment DATABASE_URL names
  // `llmwiki_app` -- measured, not assumed. Same shape as the Stack lookup: the
  // caller already knows which Stack this record belongs to, so bind it first.
  await bindStack(db, stackId);
  await db.execute(sql`
    insert into ingest_outbox
      (ingest_id, stack_id, source, title, document, body, status, dimensions)
    values (
      ${record.ingestId}, ${stackId}, ${record.source}, ${record.title},
      ${record.document}, ${record.body}, ${record.status},
      ${JSON.stringify(record.dimensions)}::jsonb
    )
    on conflict (ingest_id) do update set
      source = excluded.source,
      title = excluded.title,
      document = excluded.document,
      body = excluded.body,
      status = excluded.status,
      dimensions = excluded.dimensions,
      updated_at = now()
  `);
}

/**
 * Delete a record. Missing is not an error: two concurrent replays racing on the
 * same record must both finish successfully.
 *
 * @param db - Database handle; the tenant is bound here before the delete.
 * @param stackId - Stack the record belongs to.
 * @param ingestId - Record to delete.
 */
export async function removeRecord(
  db: Database,
  stackId: string,
  ingestId: string,
): Promise<void> {
  await bindStack(db, stackId);
  await db.execute(sql`delete from ingest_outbox where ingest_id = ${ingestId}`);
}

/**
 * Load every record of the bound Stack.
 *
 * The Stack is not a parameter and must not become one: the query runs under RLS,
 * so `app.stack_id` already decides what is visible. Passing a stack here would be
 * a second answer to a question the database owns, and the two would disagree the
 * moment one of them changed.
 *
 * A malformed `dimensions` payload is reported as `unreadable` rather than silently
 * skipped, because skipping it would hide exactly the kind of interrupted write the
 * outbox exists to catch.
 *
 * @param db - Database handle; the tenant is bound here before the read.
 * @param stackId - Stack whose records to load.
 * @returns Records, plus the ids whose payload could not be parsed.
 */
export async function loadRecords(
  db: Database,
  stackId: string,
): Promise<{ records: OutboxRecord[]; unreadable: string[] }> {
  await bindStack(db, stackId);
  // BOTH the binding and an explicit predicate, deliberately.
  //
  // The binding is what makes the tenant policy apply. The predicate is what makes
  // the query correct on a connection that bypasses it: the pool runs as `aks`, a
  // superuser that OWNS these tables, and a superuser owner bypasses its own policy
  // entirely. Measured -- with only the binding, records from other Stacks were
  // visible, which showed up as a suite that passed per-file and failed when files
  // shared one database.
  //
  // Keeping both is the same shape used elsewhere in this codebase: a filter alone
  // leaks through any path that forgets it, and a policy alone is inert wherever the
  // connection can bypass it. Together neither is load-bearing for the other.
  const rows = await db.execute<RecordRow>(
    sql`select ${sql.raw(RECORD_COLUMNS)} from ingest_outbox where stack_id = ${stackId} order by created_at asc`,
  );
  const records: OutboxRecord[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    const dimensions = parseDimensions(row.dimensions);
    if (dimensions === null) {
      unreadable.push(row.ingestId);
      continue;
    }
    records.push({
      version: 1,
      ingestId: row.ingestId,
      source: row.source,
      title: row.title,
      document: row.document,
      body: row.body,
      status: row.status === "committed" ? "committed" : "pending",
      dimensions,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    });
  }
  return { records, unreadable };
}

/**
 * Parse the `dimensions` column, or report that it cannot be trusted.
 *
 * The column is `jsonb`, so Postgres guarantees it is valid JSON but not that it has
 * the shape this module wrote. A record whose payload does not parse is unfinished
 * work with no usable description, which the caller must surface rather than treat
 * as absent.
 *
 * @param raw - Value as the driver returned it.
 * @returns The entries, or `null` when the shape is wrong.
 */
function parseDimensions(raw: unknown): readonly OutboxDimensionEntry[] | null {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return null;
  const entries: OutboxDimensionEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const name = (item as { name?: unknown }).name;
    const key = (item as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof name !== "string") return null;
    if (key !== null && typeof key !== "string") return null;
    entries.push({ name: name as DimensionName, idempotencyKey: key });
  }
  return entries;
}

/** JSON.parse that answers `null` instead of throwing. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
