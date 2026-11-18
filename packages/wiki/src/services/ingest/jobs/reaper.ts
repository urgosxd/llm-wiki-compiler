/**
 * @file src/services/ingest/jobs/reaper.ts
 * @description Settling the rows nothing will ever move again, under ONE named bound.
 *
 * ## The reported defect this answers
 *
 * The third defect reported with the hang: "no reaper for `wiki.ingest_job`". A container
 * restart kills the process that owned a job, and its row keeps saying `running` forever —
 * visible on every surface, explaining nothing, and (before T5) impossible to clear. The
 * `wiki.ingest_job` table has no expiry, and it should not: this module is the expiry, and it
 * runs where the case actually happens, at HOST BOOT.
 *
 * ## It SETTLES. It never deletes.
 *
 * Deleting on a timer is irreversible destruction of stored data, decided by a clock rather
 * than by an operator. A settled row is still there, still explains itself, and an operator who
 * wants it gone has an explicit `DELETE` (T5a/T5b). So the only write here is a terminal
 * snapshot.
 *
 * ## It never reaps on a read
 *
 * T2 proved that a status read must never mutate a row, and that proof is worth more than the
 * convenience: a read that settles rows turns every poll into a write and makes "where is my
 * job" answer different things depending on how often it was asked. Nothing in this module is
 * reachable from a request.
 *
 * ## It must never settle a job that is alive
 *
 * Silence is only evidence of abandonment when nothing this process holds is still working.
 * A live registry entry that is not terminal by `isSettled` means exactly the opposite, so the
 * row is SKIPPED and counted. At boot there is usually no live entry at all; the check is here
 * because a function that is only correct at boot is only correct by accident.
 *
 * A live entry that IS settled is worth more than any inference: it is the authority for what
 * the job did, so its snapshot is written instead of this module's guess, and a snapshot OLDER
 * than the row is refused rather than written. That window is narrow — `createJobRegistry` drops
 * a settled job an hour after it finished, so this only fires when a mirror write was lost and
 * the entry has not yet expired — but the alternative is turning an outcome this process still
 * knows into a false `abandoned` failure, which is the one thing a reaper must never do.
 *
 * ## One bound, never a second
 *
 * The bound is `resolveIngestJobStuckAfterMs`, and the comparison is `isStalled` — the same pair
 * a status READ reports with and a DELETE decides on. This module owns neither: it passes the
 * clock and the bound through and lets the shared predicate answer. A reaper with its own
 * timeout would be a second opinion about which rows are stuck, and the surfaces would drift.
 *
 * The candidate query narrows the scan by the same number for efficiency only, and cannot
 * disagree with the predicate: it fetches rows strictly older than `now - bound`, and
 * `isStalled` asks for strictly more than `bound` of silence, so a row exactly ON the bound is
 * both unfetched and not stalled.
 *
 * ## Why the reap stamp can never overtake a healthy write
 *
 * The caller passes `now`, and it is read BEFORE the candidates are: every transition that lands
 * after this run started carries a later timestamp, so the store's `updated_at` guard refuses
 * this run's write and the row keeps what the live pipeline said. Reading the clock after the
 * scan would leave a window in which a run could settle a job that had just moved.
 *
 * A write that is REFUSED by the guard is never reported as settled, because a reap that claims
 * a row it did not move is the same class of bug as a delete that claims one. The one case where
 * the guard could refuse a snapshot this module built — a live entry older than the stored row —
 * is checked before the write rather than after it.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "../../../dimensions/wiki/page-store.js";
import { isIngestJob, saveIngestJob } from "./job-store.js";
import { isSettled, type JobRegistry } from "./registry.js";
import { isStalled } from "./status.js";
import type { JobStatusOptions } from "./status.js";
import type {
  CompileDimensionState,
  IngestDimensionState,
  IngestJob,
} from "./types.js";

/** The database handle shape, taken from the write this module composes. */
type Database = Parameters<typeof saveIngestJob>[0];

/** One row this module settled. */
export interface ReapedJob {
  /** The Stack the row belongs to; the reap is always scoped to one tenant. */
  readonly stackId: string;
  /** `ing_<ULID>` identity of the row that was settled. */
  readonly jobId: string;
}

/** What one reap did, so a caller can report it instead of guessing. */
export interface ReapOutcome {
  /** Every row this run settled, in the order the Stacks were given. */
  readonly settled: readonly ReapedJob[];
  /** Rows that were stale AND alive, so they were left exactly as they were. */
  readonly skipped: number;
}

/** The clock, the bound, and the live view a reap is performed against. */
export interface ReapOptions extends JobStatusOptions {
  /**
   * The live registry of the process performing the reap, when it holds any jobs.
   *
   * A surface in another process (the MCP server) holds none and omits it. Omitted is not the
   * same as empty: without a registry this module can only reason about the row, which is why
   * the boot passes the one it just built.
   */
  readonly registry?: Pick<JobRegistry, "get">;
}

/** A compile half that can never move again, used to isolate the ingest half. */
const TERMINAL_COMPILE: CompileDimensionState = { status: "skipped", progress: null };

/** An ingest half that can never move again, used to isolate the compile half. */
const TERMINAL_INGEST: IngestDimensionState = { status: "unchanged", attempts: [] };

/** How many stale rows one Stack's scan returns, so one run cannot read the table. */
const MAX_CANDIDATE_SCAN = 500;

/**
 * The terminal state a reaped job is written with, as the reason a reader will be handed.
 *
 * It says what the conclusion is ("abandoned"), that it was DERIVED (from silence), and WHEN the
 * row last really moved — not when the reap happened, which is a fact about this run rather than
 * about the job. Beside it {@link abandonedSnapshotOf} stores the marker a read classifies from: a
 * sentence can be reworded, so the provenance is not carried in prose.
 *
 * @param job - The snapshot the decision was taken on.
 * @returns The reason, quoting the row's own last transition.
 */
export function abandonedReasonOf(job: IngestJob): string {
  return `abandoned: no update since ${job.updatedAt}; the process that owned it stopped`;
}

/** True when the INGEST half cannot move again, asked of the registry's own predicate. */
function ingestIsTerminal(job: IngestJob): boolean {
  return isSettled({ ...job, compile: TERMINAL_COMPILE });
}

/** True when the COMPILE half cannot move again, asked of the registry's own predicate. */
function compileIsTerminal(job: IngestJob): boolean {
  return isSettled({ ...job, ingest: TERMINAL_INGEST });
}

/**
 * The ingest half as a reap leaves it: untouched when it had finished, settled otherwise.
 *
 * Preserving a terminal half is the whole point. An ingest that succeeded and a compile that
 * never finished must not be rewritten as two failures: the row would lose the fact that the
 * content landed, which is the most useful thing it knew.
 */
function settleIngestHalf(job: IngestJob, nowIso: string, reason: string): IngestDimensionState {
  if (ingestIsTerminal(job)) return job.ingest;
  return { ...job.ingest, status: "failed", endedAt: nowIso, error: reason };
}

/** The compile half as a reap leaves it; see {@link settleIngestHalf} for the rule. */
function settleCompileHalf(job: IngestJob, nowIso: string, reason: string): CompileDimensionState {
  if (compileIsTerminal(job)) return job.compile;
  return { ...job.compile, status: "failed", endedAt: nowIso, error: reason };
}

/**
 * The terminal snapshot a reap writes, built from the row and NOTHING else.
 *
 * Every field of the original is carried, and each half keeps its stage, attempts, progress,
 * detail and message. Built field by field rather than by spreading the job, because the two
 * read-time fields (`statusReason`, `stalledSince`) are ATTACHED by a read and never stored by
 * the mirror: a reap that copied them into a payload would persist one run's inference and the
 * next read would quote it back as if the pipeline had reported it.
 *
 * `abandonedAt` is the exception, and it is the point of this function's shape: the conclusion
 * "the process that owned it stopped" is an INFERENCE, and the field is how the read knows that.
 * Without it a status read would find a recorded-looking failure in the row and report it as
 * something a pipeline observed, which is the fidelity this whole feature is about.
 *
 * @param job - The snapshot the decision was taken on.
 * @param nowIso - The reap instant, also the row's new `updated_at`.
 * @returns The terminal snapshot, ready for the store's version guard.
 */
export function abandonedSnapshotOf(job: IngestJob, nowIso: string): IngestJob {
  const reason = abandonedReasonOf(job);
  return {
    id: job.id,
    source: job.source,
    createdAt: job.createdAt,
    updatedAt: nowIso,
    abandonedAt: nowIso,
    ingest: settleIngestHalf(job, nowIso, reason),
    compile: settleCompileHalf(job, nowIso, reason),
  };
}

/**
 * Readable rows of ONE Stack whose last transition is strictly older than `cutoffIso`.
 *
 * A `withTenant` scope AND an explicit `stack_id` predicate: RLS is inert under a role that
 * bypasses it, so the predicate is the guarantee and the policy is the backstop. The status
 * filter is deliberately absent — terminality is `isSettled`'s answer and a list of status
 * strings in SQL would be the second copy that drifts.
 *
 * @param db - Database handle.
 * @param stackId - The one tenant to scan.
 * @param cutoffIso - `now - bound`; see this file's header on why it cannot disagree.
 * @returns Candidate snapshots, oldest first. Unreadable payloads are left alone.
 */
async function staleRowsOf(
  db: Database,
  stackId: string,
  cutoffIso: string,
): Promise<readonly IngestJob[]> {
  const rows = await withTenant(db, stackId, async (tx) =>
    tx.execute<{ payload: unknown }>(sql`
      select payload from wiki.ingest_job
      where stack_id = ${stackId} and updated_at < ${cutoffIso}::timestamptz
      order by updated_at asc
      limit ${MAX_CANDIDATE_SCAN}
    `),
  );
  return rows.map((row: { payload: unknown }) => row.payload).filter(isIngestJob);
}

/**
 * Settle ONE stale row, and say whether it was this run that moved it.
 *
 * Three answers, and the middle one is the refusal that matters: an entry this process holds
 * that is not terminal means the job is ALIVE, so the row is left byte-identical.
 *
 * @param db - Database handle.
 * @param stackId - Tenant the row belongs to.
 * @param job - The stale snapshot that was read.
 * @param nowIso - The reap instant, taken before the scan.
 * @param options - Clock, bound, and the live view.
 * @returns True when this run wrote the terminal snapshot; false when it declined to.
 */
async function reapOne(
  db: Database,
  stackId: string,
  job: IngestJob,
  nowIso: string,
  options: ReapOptions,
): Promise<boolean> {
  const live = options.registry?.get(job.id);
  if (live !== undefined && !isSettled(live)) return false;
  const snapshot = live ?? abandonedSnapshotOf(job, nowIso);
  // A live view OLDER than the row is not evidence about the row: something else wrote later,
  // and settling on a stale snapshot would overwrite a newer record with an older one.
  if (Date.parse(snapshot.updatedAt) < Date.parse(job.updatedAt)) return false;
  await saveIngestJob(db, stackId, snapshot);
  return true;
}

/**
 * Settle every abandoned row of the named Stacks.
 *
 * Per Stack, always: the ids are the caller's statement of which tenants it is responsible for,
 * and no statement here runs without one of them bound.
 *
 * Idempotent by construction rather than by bookkeeping: the settled row is terminal, so
 * `isStalled` refuses it and a second run finds nothing. A database error is allowed to
 * propagate, because a caller that got one knows nothing landed and can run again.
 *
 * @param db - Database handle.
 * @param stackIds - The tenants to reap, in the order they should be reported.
 * @param options - Clock (read once), bound, and the live view.
 * @returns What was settled, and how many stale-but-alive rows were left alone.
 */
export async function settleAbandonedJobs(
  db: Database,
  stackIds: readonly string[],
  options: ReapOptions,
): Promise<ReapOutcome> {
  // Taken BEFORE the scan: every write that lands after this instant carries a later stamp, so
  // the store's guard refuses this run instead of the other way round. See the file header.
  const nowIso = options.now.toISOString();
  const cutoffIso = new Date(options.now.getTime() - options.stuckAfterMs).toISOString();
  const settled: ReapedJob[] = [];
  let skipped = 0;
  for (const stackId of stackIds) {
    for (const job of await staleRowsOf(db, stackId, cutoffIso)) {
      // The ONE comparison, shared with a status read and a delete.
      if (!isStalled(job, options)) continue;
      if (await reapOne(db, stackId, job, nowIso, options)) settled.push({ stackId, jobId: job.id });
      else skipped += 1;
    }
  }
  return { settled, skipped };
}

/**
 * Every Stack this deployment has, most recently updated first.
 *
 * A boot has to name the tenants it reaps, and it cannot ask for them per request the way a route
 * does: after a restart, the row is the only evidence left. `stacks` is the tenant registry and
 * carries no tenant policy of its own, so reading ids here crosses no boundary — no tenant's
 * private content is read, and every settle goes back through {@link settleAbandonedJobs}, which
 * binds one Stack per statement.
 *
 * Recently active Stacks come first so a caller that runs out of time reaps where a stuck row is
 * most likely, and the order is deterministic, so a listing is not heap order.
 *
 * @param db - Database handle.
 * @returns The Stack ids, newest activity first.
 */
export async function listStackIds(db: Database): Promise<readonly string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from stacks order by updated_at desc, id
  `);
  return rows.map((row: { id: string }) => row.id);
}
