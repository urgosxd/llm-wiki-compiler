/**
 * @file src/services/ingest/jobs/registry.ts
 * @description The in-process store of async ingest jobs: create, advance, read.
 *
 * ## Why memory, and what that costs
 *
 * Job state lives in the process that accepted the request. This was a decision,
 * not a shortcut: ingestion already requires the project mutation lock, which is
 * a filesystem lock under `.llmwiki/`, so two processes cannot ingest the same
 * project at once anyway. A durable store would have to be either a Postgres
 * table -- and a `queued` job cannot live inside a transaction that has not opened
 * yet -- or a file per transition, which buys nothing while the lock already
 * serializes the work.
 *
 * The accepted cost is explicit: if the process dies mid-job, the in-memory job
 * is gone. What survives is the FAILURE record, written by
 * `./failure-log.ts`, so a restart can still answer "why did this upload never
 * appear". A job that vanished because it was in flight is not the same as one
 * that vanished silently, and only the second is a real problem.
 *
 * ## Bounded, so a long-running host cannot leak
 *
 * Two independent bounds:
 *
 *   - {@link MAX_JOBS} caps the number of retained jobs. On overflow the OLDEST
 *     settled job is dropped first; an in-flight job is never evicted, because
 *     dropping one would orphan a running ingest from its own status surface.
 *   - {@link JOB_TTL_MS} drops settled jobs older than the window. The sweep runs
 *     lazily on read instead of on a timer: a background `setInterval` would keep
 *     the Node event loop alive and prevent a one-shot CLI process from exiting,
 *     which is a real regression for a project that is mostly a CLI.
 *
 * ## Immutability is what makes a snapshot safe to serve
 *
 * Every transition REPLACES the job record rather than mutating it. A reader that
 * got a snapshot keeps a consistent view even if a transition lands between its
 * read and its serialization; a mutating store would let a handler serialize half
 * of one state and half of another.
 */

import { ulid } from "../../../relations/ulid.js";
import {
  queuedCompileState,
  queuedIngestState,
  type AttemptRecord,
  type CompileDimensionState,
  type IngestDimensionState,
  type IngestJob,
} from "./types.js";

/** How many jobs are retained before the oldest settled one is evicted. */
export const MAX_JOBS = 200;

/** How long a SETTLED job stays readable, in milliseconds (one hour). */
const JOB_TTL_MS = 60 * 60 * 1000;

/** States after which a job will not change again. */
const SETTLED_INGEST = new Set(["succeeded", "unchanged", "failed"]);

/**
 * True when the job can no longer transition.
 *
 * A job is settled only when BOTH dimensions are terminal-or-absent: an ingest
 * that succeeded while its compile is still `running` is not finished, and
 * evicting it would delete the status of work that is still happening.
 */
function isSettled(job: IngestJob): boolean {
  if (!SETTLED_INGEST.has(job.ingest.status)) return false;
  return job.compile.status === "skipped"
    || job.compile.status === "succeeded"
    || job.compile.status === "failed"
    || job.compile.status === "busy";
}

/** The registry surface the HTTP layer and the pipelines use. */
export interface JobRegistry {
  /**
   * Mint and store a job in its `queued` state.
   *
   * `stackId` is the Stack the caller named, when it named one. It rides on the
   * creation call rather than on the registry because one host serves several Stacks
   * and the choice belongs to the request. Omitted, the host's bound Stack applies.
   */
  create(source: string, now: Date, stackId?: string): IngestJob;
  /** Current snapshot of `id`, or `undefined` when unknown, evicted, or expired. */
  get(id: string): IngestJob | undefined;
  /** Every retained job, newest first. */
  list(): readonly IngestJob[];
  /** Replace `id`'s ingest dimension. No-op for an unknown id. */
  patchIngest(id: string, patch: Partial<IngestDimensionState>, now: Date): void;
  /** Replace `id`'s compile dimension. No-op for an unknown id. */
  patchCompile(id: string, patch: Partial<CompileDimensionState>, now: Date): void;
  /** Replace `id`'s attempt list. No-op for an unknown id. */
  patchAttempts(id: string, attempts: readonly AttemptRecord[], now: Date): void;
  /** Drop every job. Test seam only. */
  clear(): void;
}

/**
 * Evict the oldest settled job until the store is under {@link MAX_JOBS}.
 *
 * In-flight jobs are skipped rather than counted as evictable. If every retained
 * job is in flight the store is allowed to exceed the cap: dropping live work to
 * satisfy a memory bound would break the feature's whole purpose.
 */
function evictOverflow(jobs: Map<string, IngestJob>): void {
  if (jobs.size <= MAX_JOBS) return;
  const settled = [...jobs.values()].filter(isSettled);
  for (const job of settled) {
    if (jobs.size <= MAX_JOBS) return;
    jobs.delete(job.id);
  }
}

/** Drop settled jobs whose last transition is older than {@link JOB_TTL_MS}. */
function evictExpired(jobs: Map<string, IngestJob>, now: Date): void {
  const cutoff = now.getTime() - JOB_TTL_MS;
  for (const job of [...jobs.values()]) {
    if (!isSettled(job)) continue;
    if (Date.parse(job.updatedAt) < cutoff) jobs.delete(job.id);
  }
}

/** Apply a partial patch to a job record, always advancing `updatedAt`. */
function withPatch(
  job: IngestJob,
  patch: { ingest?: Partial<IngestDimensionState>; compile?: Partial<CompileDimensionState> },
  now: Date,
): IngestJob {
  return {
    ...job,
    updatedAt: now.toISOString(),
    ingest: patch.ingest === undefined ? job.ingest : { ...job.ingest, ...patch.ingest },
    compile: patch.compile === undefined ? job.compile : mergeCompile(job.compile, patch.compile),
  };
}

/**
 * Merge a compile patch, honouring an explicit `undefined` as a DELETION.
 *
 * A plain spread cannot remove a field: `{ ...old, detail: undefined }` leaves a
 * present-but-undefined key, which serializes away but reads as "set to nothing"
 * rather than "never set". `detail` must be genuinely absent, never an empty or
 * zeroed object, or a consumer could render "0 chunks" for a stage that embedded
 * nothing. Every other field keeps the overwrite semantics the spread gives it.
 *
 * The distinction is KEY PRESENCE, not value: a patch that never mentions `detail`
 * (a status transition, which is most of them) must leave it alone. Testing the
 * value instead deleted the cardinality on every settle, so the count vanished the
 * moment the run finished — exactly when an operator wants to read it.
 */
function mergeCompile(
  current: CompileDimensionState,
  patch: Partial<CompileDimensionState>,
): CompileDimensionState {
  const merged = { ...current, ...patch };
  if ("detail" in patch && patch.detail === undefined) delete merged.detail;
  return merged;
}

/**
 * Build a fresh in-memory job registry.
 *
 * One instance per host (or per test), never a module-level singleton: a singleton
 * would share jobs across two hosts in one process and across test files, and the
 * leak would look like a feature until two projects collided.
 *
 * @returns A registry with no jobs.
 */
export function createJobRegistry(): JobRegistry {
  const jobs = new Map<string, IngestJob>();

  return {
    create(source, now, stackId) {
      const at = now.toISOString();
      const job: IngestJob = {
        id: `ing_${ulid()}`,
        source,
        createdAt: at,
        updatedAt: at,
        ingest: queuedIngestState(),
        compile: queuedCompileState(),
      };
      jobs.set(job.id, job);
      evictOverflow(jobs);
      return job;
    },

    get(id) {
      evictExpired(jobs, new Date());
      return jobs.get(id);
    },

    list() {
      evictExpired(jobs, new Date());
      return [...jobs.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },

    patchIngest(id, patch, now) {
      const job = jobs.get(id);
      if (job === undefined) return;
      jobs.set(id, withPatch(job, { ingest: patch }, now));
    },

    patchCompile(id, patch, now) {
      const job = jobs.get(id);
      if (job === undefined) return;
      jobs.set(id, withPatch(job, { compile: patch }, now));
    },

    patchAttempts(id, attempts, now) {
      const job = jobs.get(id);
      if (job === undefined) return;
      jobs.set(id, withPatch(job, { ingest: { attempts } }, now));
    },

    clear() {
      jobs.clear();
    },
  };
}
