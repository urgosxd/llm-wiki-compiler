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
 * What it could not do is be read by `llmwiki serve`. The MCP server is a separate
 * process over stdio, it shares no memory with `llmwiki host`, and an agent driving
 * the product through MCP is the caller who wants to poll instead of block. So the
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

/** True when the row's snapshot is a shape this module can hand back. */
function isIngestJob(value: unknown): value is IngestJob {
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
  const rows = await withTenant(db, stackId, async (tx) =>
    tx.execute<{ payload: unknown }>(sql`
      select payload from wiki.ingest_job
      where stack_id = ${stackId} and job_id = ${jobId}
    `),
  );
  const payload = rows[0]?.payload;
  return isIngestJob(payload) ? payload : undefined;
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
