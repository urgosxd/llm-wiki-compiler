/**
 * @file src/services/ingest/jobs/job-store.ts
 * @description Durable read/write of `wiki.ingest_job`, so a SECOND process can
 * answer "how is my ingest going".
 *
 * ## Why this exists beside the in-memory registry
 *
 * `registry.ts` keeps the live view: `create`, `patch*`, `list`, all synchronous,
 * all in one process. That is the right shape for the host that owns the job, and
 * it stays exactly as it is — this module does not replace it.
 *
 * What it could not do is be read by the MCP server. That is a separate process over
 * stdio, it shares no memory with the host, and an agent driving the product through
 * MCP is the caller who wants to poll instead of block. So the
 * host mirrors every transition here and the MCP reads from here.
 *
 * ## Why the payload is stored whole
 *
 * `IngestJob` is immutable by contract: a transition REPLACES the snapshot. The two
 * dimension states are nested with a variable-length attempt list, and every reader
 * wants the whole thing — so the row stores the snapshot as `jsonb` and promotes
 * only the columns a reader filters on. Normalizing would buy join cost for a value
 * that is never read piecemeal.
 *
 * ## Failure is never fatal to the job
 *
 * A store write happens AFTER the in-memory transition has already succeeded, so a
 * database problem must not turn a working ingest into a failed one. Every write is
 * best-effort and swallows its error into a reported callback: the live view stays
 * authoritative for the owning process, and durability is what a later reader gets
 * when it worked.
 *
 * ## A stale snapshot never overwrites a newer one
 *
 * A process patches one job many times while it runs, and two of those writes can be in
 * flight at once. Postgres resolves them in commit order, not in patch order, so an
 * OLDER snapshot that arrives last used to win — the measured row that kept reporting
 * `running`/`queued` after the in-memory job had settled, with a frozen `updated_at`.
 * The upsert therefore applies only when the incoming snapshot is not older than the
 * stored row.
 *
 * Equal timestamps APPLY. Two patches stamped in the same millisecond are not two
 * versions of one state to choose between, and rejecting the equal one would hand the
 * row to whichever write arrived first — which is the older patch, the exact wrong
 * answer. Strictly older is the only case this refusal is for.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "../../../dimensions/wiki/page-store.js";

/**
 * The database handle shape, taken from `withTenant` rather than imported from
 * `llmwiki-kg` directly: the core's declaration build does not resolve that
 * specifier for a module it has never seen before, and `withTenant` already
 * declares exactly the handle this module needs.
 */
type Database = Parameters<typeof withTenant>[0];
import type { IngestJob } from "./types.js";

/** How many jobs a listing returns when the caller does not say otherwise. */
const DEFAULT_LIST_LIMIT = 50;

/** Largest listing this module will return, so one call cannot read the table. */
const MAX_LIST_LIMIT = 200;

/**
 * True when the row's snapshot is a shape this module can hand back.
 *
 * Exported because the reaper reads rows straight from the table as well
 * (`reaper.ts`), and a second copy of this guard is a second definition of "readable".
 */
export function isIngestJob(value: unknown): value is IngestJob {
  const candidate = value as Partial<IngestJob> | null;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.id === "string" &&
    typeof candidate.source === "string" &&
    candidate.ingest !== undefined &&
    candidate.compile !== undefined
  );
}

/**
 * Persist one job snapshot, replacing whatever was there.
 *
 * @param db - Database handle.
 * @param stackId - Tenant the job belongs to; also what the RLS policy binds.
 * @param job - The complete snapshot, as the wire would see it.
 */
export async function saveIngestJob(
  db: Database,
  stackId: string,
  job: IngestJob,
): Promise<void> {
  await withTenant(db, stackId, async (tx) => {
    await tx.execute(sql`
      insert into wiki.ingest_job
        (stack_id, job_id, source, ingest_status, compile_status, payload, created_at, updated_at)
      values (
        ${stackId}, ${job.id}, ${job.source},
        ${job.ingest.status}, ${job.compile.status},
        ${JSON.stringify(job)}::jsonb,
        ${job.createdAt}::timestamptz, ${job.updatedAt}::timestamptz
      )
      on conflict (stack_id, job_id) do update set
        source = excluded.source,
        ingest_status = excluded.ingest_status,
        compile_status = excluded.compile_status,
        payload = excluded.payload,
        updated_at = excluded.updated_at
      -- ingest_job is the stored row, excluded the snapshot being written. Only a
      -- write that moves the row FORWARD may land; see this file's header.
      where ingest_job.updated_at <= excluded.updated_at
    `);
  });
}

/**
 * Read one job by id.
 *
 * @param db - Database handle.
 * @param stackId - Tenant the caller is asking about.
 * @param jobId - `ing_<ULID>` identity.
 * @returns The snapshot, or `undefined` when this Stack never had that job.
 */
export async function readIngestJob(
  db: Database,
  stackId: string,
  jobId: string,
): Promise<IngestJob | undefined> {
  return (await readIngestJobVersion(db, stackId, jobId))?.job;
}

/** One stored job, together with the version the DATABASE holds for the row. */
export interface StoredIngestJob {
  /** The snapshot, as a reader sees it. */
  readonly job: IngestJob;
  /**
   * `wiki.ingest_job.updated_at` as the database itself prints it, in ISO 8601 with whatever
   * precision the column holds — microseconds included.
   *
   * NOT `job.updatedAt`. The payload travels through JSON, and a writer can truncate it to
   * milliseconds (or to anything else) before it is stored, so the payload's copy of the
   * instant is a CLAIM about the row rather than the row's identity. Anything that has to
   * recognise the same row version later — a conditional delete, which is irreversible — has
   * to carry this value instead.
   */
  readonly version: string;
}

/**
 * Read one job together with the row version the database reports for it.
 *
 * ## Why the version comes from the column and not from the payload
 *
 * A delete is irreversible and is conditioned on "has this row changed since I read it?".
 * Answering that with `payload.updatedAt` compared against the column answers a different
 * question — "does the payload spell the column's instant exactly?" — and the answer is no
 * whenever the stored column carries microseconds the payload cannot (`now()` on a column, a
 * `MS`-formatted payload, any foreign writer). The measured consequence was a row that could
 * never be deleted: every attempt refused as `job_changed`, permanently.
 *
 * So the read returns the COLUMN's own value, printed by the database, and the conditional
 * delete compares column against column. The guard keeps its meaning — a row that moved on is
 * still refused — and stops depending on how faithfully a payload was serialised.
 *
 * @param db - Database handle.
 * @param stackId - Tenant the caller is asking about.
 * @param jobId - `ing_<ULID>` identity.
 * @returns The snapshot and its row version, or `undefined` when no readable row exists.
 */
export async function readIngestJobVersion(
  db: Database,
  stackId: string,
  jobId: string,
): Promise<StoredIngestJob | undefined> {
  const rows = await withTenant(db, stackId, async (tx) =>
    tx.execute<{ payload: unknown; version: string }>(sql`
      select payload, to_json(updated_at) #>> '{}' as version
      from wiki.ingest_job
      where stack_id = ${stackId} and job_id = ${jobId}
    `),
  );
  const row = rows[0];
  if (row === undefined || !isIngestJob(row.payload)) return undefined;
  return { job: row.payload, version: String(row.version) };
}

/**
 * Delete one job row, but only the version the caller decided on.
 *
 * ## Why the version is part of the operation
 *
 * A delete is irreversible, and the decision to allow it was taken from a snapshot read a
 * moment earlier. Between those two reads the job can move: a stalled row can resume, and a
 * row that resumed is work in progress that must NOT be dropped. So the statement carries
 * the row version it was decided on, and a row that has moved since matches nothing — the
 * caller learns that nothing was deleted instead of losing a live job.
 *
 * `updated_at` only moves forward here (see this file's upsert guard), so "the same
 * version" and "not newer than the version read" are the same test.
 *
 * ## Why the version must be the COLUMN's, not the payload's
 *
 * This comparison decides whether a row is the one the caller read, so it can only be made
 * against a value the database produced. `expectUpdatedAt` is therefore what
 * {@link readIngestJobVersion} returned, never `job.updatedAt`: a payload can be truncated to
 * milliseconds on the way in, and comparing it to a microsecond column refuses EVERY delete
 * of that row — the reported "no hay manera de eliminarlo" reintroduced as a precision
 * mismatch, with no way out for the operator.
 *
 * @param db - Database handle.
 * @param stackId - Tenant the job belongs to; also what the RLS policy binds.
 * @param jobId - `ing_<ULID>` identity.
 * @param expectUpdatedAt - The row version the database reported for this job; see above.
 * @returns True when the row was removed; false when it is absent or has moved on.
 */
export async function deleteIngestJobAtVersion(
  db: Database,
  stackId: string,
  jobId: string,
  expectUpdatedAt: string,
): Promise<boolean> {
  const removed = await withTenant(db, stackId, async (tx) =>
    tx.execute<{ job_id: string }>(sql`
      delete from wiki.ingest_job
      where stack_id = ${stackId} and job_id = ${jobId}
        and updated_at = ${expectUpdatedAt}::timestamptz
      returning job_id
    `),
  );
  return removed.length > 0;
}

/**
 * List this Stack's jobs, newest transition first.
 *
 * @param db - Database handle.
 * @param stackId - Tenant whose jobs are listed.
 * @param limit - Cap on returned rows; clamped to a bounded range.
 * @returns Every readable snapshot, newest first. Unreadable rows are skipped.
 */
export async function listIngestJobs(
  db: Database,
  stackId: string,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<readonly IngestJob[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
  const rows = await withTenant(db, stackId, async (tx) =>
    tx.execute<{ payload: unknown }>(sql`
      select payload from wiki.ingest_job
      where stack_id = ${stackId}
      order by updated_at desc
      limit ${bounded}
    `),
  );
  return rows.map((row: { payload: unknown }) => row.payload).filter(isIngestJob);
}
