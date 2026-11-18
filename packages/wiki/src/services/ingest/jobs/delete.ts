/**
 * @file src/services/ingest/jobs/delete.ts
 * @description Removing one job record, and refusing to remove one that may still be working.
 *
 * ## The report this answers
 *
 * "no hay manera de eliminarlo" — a job that never settles stays in `wiki.ingest_job`
 * forever, and nothing clears it. This module is that operation, and it is deliberately the
 * ONLY one: a generic "mutate any job" surface would let a later caller reach around the
 * policy below.
 *
 * ## When a delete is allowed
 *
 * One question, asked of the predicate the repository already owns:
 *
 *   - a job SETTLED by `isSettled` is finished, so removing its record takes nothing away
 *     from work in progress — allowed;
 *   - a job that is non-terminal but silent past the named stuck bound
 *     (`resolveIngestJobStuckAfterMs`) is exactly the row the reporter could not clear —
 *     allowed;
 *   - a job that is non-terminal and INSIDE that bound may be running right now. Deleting
 *     it would orphan real work from its own status surface, so it is refused;
 *   - an id this Stack never had, and a Stack that does not exist, are refusals as well:
 *     there is nothing to delete, and saying so is not the same as deleting something else.
 *
 * The bound is not re-derived here. `status.ts` performs the comparison and this module
 * reads it ({@link isStalled}), so the surface that REPORTS a stuck row and the one that
 * DELETES it can never disagree about which rows are stuck.
 *
 * ## A refusal writes nothing
 *
 * Every refusal below returns before a statement runs, and the allowed path deletes at the row
 * version the DATABASE reported — see `readIngestJobVersion`. The repository's rule for job
 * storage is that a refused action leaves the stored row byte-identical — same statuses, same
 * `updated_at`, same payload, same counters — because a "cannot delete" that quietly moved a
 * row is a worse bug than the one being fixed.
 *
 * The version is the column's, never the payload's `updatedAt`: a payload can be truncated to
 * milliseconds on the way in, and comparing that to a microsecond column refused EVERY delete
 * of such a row, permanently — the reporter's complaint reintroduced by a precision mismatch.
 *
 * ## Who removes the live entry
 *
 * A surface running in the process that OWNS the job passes its registry; a surface in
 * another process (the MCP server) holds no live jobs and passes nothing. The entry is
 * dropped only AFTER the durable row is gone, so a caller never sees the live view cleared
 * for a delete that did not happen.
 */

import { isSettled } from "./registry.js";
import type { JobRegistryRecovery } from "./registry.js";
import { deleteIngestJobAtVersion, readIngestJobVersion } from "./job-store.js";
import { isStalled } from "./status.js";
import type { JobStatusOptions } from "./status.js";
import type { IngestJob } from "./types.js";

/** The database handle shape, taken from the read it composes. */
type Database = Parameters<typeof deleteIngestJobAtVersion>[0];

/** How a stored job classifies for deletion. */
export type JobDeletability = "settled" | "stalled" | "working";

/** Why a delete was refused. */
export type DeleteRefusalReason = "unknown-job" | "still-live" | "changed";

/** What the policy answered: the removed snapshot, or the refusal and its message. */
export type DeleteIngestJobOutcome =
  | { readonly deleted: true; readonly job: IngestJob }
  | { readonly deleted: false; readonly reason: DeleteRefusalReason; readonly message: string };

/** The clock, the bound, and the live view a delete is performed against. */
export interface DeleteJobOptions extends JobStatusOptions {
  /**
   * The live registry of the process performing the delete, when it holds the job.
   *
   * Omitted by a surface that runs in another process — the MCP server reads and writes
   * `wiki.ingest_job` only, and has no live entry to drop.
   */
  readonly registry?: JobRegistryRecovery;
}

/**
 * Classify a stored job for deletion.
 *
 * Settled is asked FIRST and separately: `isStalled` answers `false` for a settled row, so
 * a settle/report asymmetry here would turn a finished job into "working".
 *
 * @param job - The stored snapshot.
 * @param options - Clock and bound.
 * @returns `settled`, `stalled` (allowed) or `working` (refused).
 */
export function deletabilityOf(job: IngestJob, options: JobStatusOptions): JobDeletability {
  if (isSettled(job)) return "settled";
  return isStalled(job, options) ? "stalled" : "working";
}

/**
 * The refusal a caller sees for a job that is not there.
 *
 * Wording shared with `ingest_job_status`, which answers a read the same way: one
 * vocabulary for one condition, on both job tools.
 *
 * @param jobId - The id that was asked for.
 * @returns The refusal message.
 */
function unknownJobMessage(jobId: string): string {
  return `No ingest job '${jobId}' for this Stack.`;
}

/**
 * The refusal a caller sees for a job that is plausibly running.
 *
 * @param job - The stored snapshot.
 * @returns The refusal message, naming the two dimensions so the caller can look them up.
 */
function stillWorkingMessage(job: IngestJob): string {
  return (
    `Ingest job '${job.id}' is still working (ingest '${job.ingest.status}', ` +
    `compile '${job.compile.status}'), so it was not deleted. A job that has made no ` +
    "progress for longer than the stuck bound can be deleted."
  );
}

/**
 * Delete one job if the policy allows it, and say why when it does not.
 *
 * @param db - Database handle.
 * @param stackId - The Stack the caller named; the row is inside it or nowhere.
 * @param jobId - `ing_<ULID>` identity.
 * @param options - Clock, bound, and the live registry to clear when this process owns it.
 * @returns The removed snapshot, or a refusal that already wrote nothing.
 */
export async function deleteRecoverableJob(
  db: Database,
  stackId: string,
  jobId: string,
  options: DeleteJobOptions,
): Promise<DeleteIngestJobOutcome> {
  const stored = await readIngestJobVersion(db, stackId, jobId);
  if (stored === undefined) {
    return { deleted: false, reason: "unknown-job", message: unknownJobMessage(jobId) };
  }
  const job = stored.job;
  if (deletabilityOf(job, options) === "working") {
    return { deleted: false, reason: "still-live", message: stillWorkingMessage(job) };
  }
  // The row is deleted at the version the DATABASE reported, so a job that resumed between the
  // read above and this statement is left alone — and a row whose payload cannot spell its own
  // column exactly is still deletable.
  if (!(await deleteIngestJobAtVersion(db, stackId, jobId, stored.version))) {
    return {
      deleted: false,
      reason: "changed",
      message:
        `Ingest job '${jobId}' changed while it was being deleted, so it was not deleted. ` +
        "Retry the delete.",
    };
  }
  options.registry?.delete(jobId);
  return { deleted: true, job };
}
