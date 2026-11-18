/**
 * @file src/services/ingest/jobs/durable-registry.ts
 * @description A `JobRegistry` that also mirrors every transition into Postgres.
 *
 * ## Why a decorator rather than a rewrite
 *
 * The in-memory registry is the LIVE view for the process that owns the job: it is
 * synchronous, it holds every retained job, and `run.ts` plus the HTTP handlers are
 * written against exactly its shape. Replacing it with a database-backed store
 * would make every stage transition a network round trip inside the ingest's own
 * critical path, and would put a failure mode (database hiccup) in front of work
 * that has nothing to do with the database.
 *
 * So the live view stays authoritative and this wrapper adds durability beside it.
 * Every method delegates first — so the caller's contract is unchanged — and then
 * mirrors the resulting snapshot, best-effort, into `wiki.ingest_job`.
 *
 * ## Why the mirror cannot fail a job
 *
 * Durability exists for a LATER reader (the MCP server, a UI after a restart). It is
 * not on the path of the work. A write that throws is reported through `onError`
 * and swallowed, because turning a working ingest into a failed one over a status
 * row is the worse bug of the two.
 *
 * ## Why the whole snapshot is re-read after a patch
 *
 * `IngestJob` is immutable: each `patch*` REPLACES it. Reading it back from the
 * live registry after the patch is what makes the stored row the same value the
 * live reader would have seen, without this module re-implementing the transition
 * rules — which is where two copies of a state machine start to disagree.
 *
 * ## Why writes for ONE job are chained
 *
 * A transition happens in memory immediately; its mirror write is a database round trip
 * that the caller never waits for. Two writes for the same job therefore used to be in
 * flight at once, and Postgres commits them in whatever order the network delivers —
 * measured as a settled job whose row kept the pre-failure snapshot, which is the hang
 * the reporter saw. So each job's writes are queued behind that job's previous write:
 * they commit in the order the patches happened.
 *
 * Per job, never per registry: two unrelated jobs must not wait for each other, and a
 * slow write for one job must not delay another's mirror. Nothing here awaits from the
 * live view's side either — `JobRegistry`'s methods stay synchronous, so no in-memory
 * transition can block on a database.
 *
 * The chain cannot be the whole guarantee: a write issued by a process that never saw
 * the row, or a retry the chain had to skip past, can still arrive stale. `job-store.ts`
 * holds the `updated_at` guard for exactly those cases; the chain is what keeps the
 * ordinary path from needing it.
 *
 * ## Why the chain is FLUSHABLE, and bounded
 *
 * A chain closes write ORDER, not shutdown durability: the terminal write is queued and
 * nothing waited for it, so a process that exits right after settling could still leave
 * the pre-failure snapshot. In a container a restart is routine, which makes that the
 * reported symptom by a third road. So a close can await the queue — and only up to a
 * named bound, because blocking shutdown forever on a database that is gone is a worse
 * failure than the one being fixed. A flush that runs out of bound NAMES the job ids it
 * left unwritten instead of pretending they landed.
 */

import type { JobRegistry } from "./registry.js";
import type { IngestJob } from "./types.js";
import { saveIngestJob } from "./job-store.js";
import type { DatabaseHandle } from "@repo/foundation";
import {
  INGEST_JOB_MIRROR_FLUSH_TIMEOUT_ENV_VAR,
  INGEST_JOB_MIRROR_FLUSH_TIMEOUT_MS_DEFAULT,
} from "../../../utils/constants.js";

/** A timer seam, so a bound can be proved without depending on elapsed time. */
export interface MirrorFlushTimers {
  /**
   * Run `onExpire` after `delayMs`, unless the returned cancel runs first.
   *
   * @param delayMs - The bound, in milliseconds.
   * @param onExpire - What to do when it expires.
   * @returns The cancel for a flush that finished before the bound.
   */
  schedule(delayMs: number, onExpire: () => void): () => void;
}

/** The write queue behind a durable registry: the per-job chain plus its bounded flush. */
export interface IngestJobMirrorQueue {
  /**
   * Queue one write behind every earlier write for the SAME job.
   *
   * @param jobId - The job whose patches the write belongs to.
   * @param write - Performs the write. Must absorb its own failure; a rejection here
   *   would be reported nowhere and would strand the job's chain.
   */
  track(jobId: string, write: () => Promise<void>): void;
  /**
   * Await every queued write, up to `timeoutMs`.
   *
   * @param timeoutMs - How long a shutdown is willing to wait.
   * @returns The job ids still unwritten when the bound expired; empty when all landed.
   */
  flush(timeoutMs: number): Promise<readonly string[]>;
}

/** Longest delay a platform timer accepts; anything above it fires immediately. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The real timer, unref'd so the bound alone never keeps the process alive.
 *
 * Without `unref` a pending shutdown bound is a live handle, and a process whose work is
 * finished would sit until it expired — the opposite of the property this bound exists for.
 */
const SYSTEM_TIMERS: MirrorFlushTimers = {
  schedule(delayMs, onExpire) {
    const handle = setTimeout(onExpire, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    handle.unref();
    return () => clearTimeout(handle);
  },
};

/**
 * The bound a close waits for its in-flight mirror writes, in milliseconds.
 *
 * Same parsing rule as the provider timeouts (`readTimeoutEnv` in `providers/openai.ts`):
 * unset, empty, non-numeric, zero and negative all fall back to the named default rather
 * than inventing a second convention. This module reads it from an EXPLICIT environment so
 * the caller hands over the one it was started with, and so the jobs layer does not depend
 * on the provider layer for one trim-and-parse.
 *
 * @param env - Environment to read; defaults to this process's own.
 * @returns A positive bound in milliseconds.
 */
export function resolveMirrorFlushTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INGEST_JOB_MIRROR_FLUSH_TIMEOUT_ENV_VAR]?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return INGEST_JOB_MIRROR_FLUSH_TIMEOUT_MS_DEFAULT;
  return Math.trunc(parsed);
}

/**
 * Create one write queue.
 *
 * Shared by every wrapper a host builds when it serves several Stacks, so shutdown flushes
 * once instead of walking wrappers that may already have been evicted. Two unrelated jobs
 * still never wait for each other: the chain is keyed by job id.
 *
 * @param options - Timer seam; the real one by default.
 * @returns The queue.
 */
export function createIngestJobMirrorQueue(
  options: { readonly timers?: MirrorFlushTimers } = {},
): IngestJobMirrorQueue {
  const timers = options.timers ?? SYSTEM_TIMERS;
  const writes = new Map<string, Promise<void>>();

  const track = (jobId: string, write: () => Promise<void>): void => {
    const previous = writes.get(jobId) ?? Promise.resolve();
    const tail: Promise<void> = previous
      // A predecessor's failure is the predecessor's problem, already reported: it must
      // not cancel this write.
      .catch(() => undefined)
      .then(write)
      .catch(() => undefined)
      // `finally`, not `then`: this bookkeeping must run whatever the write did, including
      // a sink that threw. A `then` was skipped in exactly that case, stranding an entry.
      .finally(() => {
        // Only the last writer clears the entry, so a queued successor is not orphaned.
        if (writes.get(jobId) === tail) writes.delete(jobId);
      });
    writes.set(jobId, tail);
  };

  const flush = (timeoutMs: number): Promise<readonly string[]> => {
    if (writes.size === 0) return Promise.resolve([]);
    const settled = Promise.all([...writes.values()].map((write) => write.catch(() => undefined)));
    return new Promise<readonly string[]>((resolve) => {
      let answered = false;
      const answer = (unwritten: readonly string[]): void => {
        if (answered) return;
        answered = true;
        resolve(unwritten);
      };
      const cancel = timers.schedule(timeoutMs, () => answer([...writes.keys()]));
      void settled.then(() => {
        cancel();
        answer([]);
      });
    });
  };

  return { track, flush };
}

/** What the wrapper needs beyond the registry it wraps. */
export interface DurableRegistryOptions {
  /** Handle used for the mirror. */
  readonly db: DatabaseHandle;
  /**
   * The Stack a job belongs to, when the caller names one.
   *
   * A function rather than a string because ONE host now serves several Stacks: the
   * request decides which, and the decision arrives with the job rather than with the
   * registry. Binding a single Stack here made `stackId` on `POST /api/ingest` a lie --
   * the live registry got the requested Stack while the durable row went to the host's
   * startup Stack, so reading the job back under the requested id returned 404.
   *
   * Absent, the mirror uses the tenant this wrapper was constructed with (`stackId`
   * below). That is not a Stack filled in from a request's absence: the host builds one
   * wrapper per job, bound to the Stack THAT request named, and a request that names none
   * is refused by name before any job exists -- the process environment never stands in
   * for it.
   */
  readonly stackIdFor?: (job: IngestJob) => string | undefined;
  /** The tenant this wrapper mirrors into when a job's own Stack is not known. */
  readonly stackId: string;
  /** Called when a mirror write fails. Never rethrown: see the file header. */
  readonly onError?: (error: unknown) => void;
  /**
   * Write queue to use instead of a private one.
   *
   * A host that serves several Stacks builds one wrapper per job over ONE database, so it
   * passes one shared queue and flushes that queue once at shutdown, instead of walking
   * wrappers that may already have been evicted from the live registry.
   */
  readonly queue?: IngestJobMirrorQueue;
}

/**
 * A durable registry: the live registry's contract, plus the bounded flush a close needs.
 *
 * The flush is the ONLY added method, and every {@link JobRegistry} method stays
 * synchronous, so no live-path caller can be made to wait for Postgres.
 */
export interface DurableJobRegistry extends JobRegistry {
  /**
   * Await this registry's in-flight mirror writes, up to a bound.
   *
   * @param timeoutMs - Bound; defaults to {@link resolveMirrorFlushTimeoutMs}.
   * @returns Job ids left unwritten because the bound expired; empty when all landed.
   */
  flushMirror(timeoutMs?: number): Promise<readonly string[]>;
}

/**
 * Wrap a registry so its transitions are also durable.
 *
 * @param inner - The live registry the host already owns.
 * @param options - DatabaseHandle, tenant, the error sink, and an optional shared queue.
 * @returns A registry with the same contract, an added mirror, and a bounded flush.
 */
export function createDurableJobRegistry(
  inner: JobRegistry,
  options: DurableRegistryOptions,
): DurableJobRegistry {
  /**
   * Hand a failed write to the caller's sink, and never let the sink break the chain.
   *
   * The sink is CALLER code: a logger whose stream has closed throws. A throw here used to
   * reject the chain's own tail, so the cleanup below was skipped and the rejection
   * surfaced unhandled — one stranded entry per job id whose sink threw. The mirror has
   * nothing further to do with an error its own sink refused.
   */
  const report = (error: unknown): void => {
    if (options.onError === undefined) return;
    try {
      options.onError(error);
    } catch {
      // Deliberate: the write already failed, and this job's next write must still run.
      return;
    }
  };

  /**
   * Stack each job was created in.
   *
   * Remembered from creation because the transitions that follow carry no Stack of
   * their own -- `patchIngest`/`patchCompile` name a job id and nothing else. Without
   * this, a job created in B would mirror its first transition back into A, which is
   * the same wrong-tenant write one step later.
   */
  const stacksByJob = new Map<string, string>();

  /** The Stack this job belongs to: the one remembered for it, else the wrapper's tenant. */
  const stackIdOf = (job: IngestJob): string =>
    stacksByJob.get(job.id) ?? options.stackIdFor?.(job) ?? options.stackId;

  /**
   * The write still to run for each job, in the order that job's patches happened.
   *
   * Owned by the queue rather than by this wrapper, so a host that builds one wrapper per
   * job can share a single queue and flush all of them from one place at shutdown.
   */
  const queue = options.queue ?? createIngestJobMirrorQueue();

  /**
   * Queue one mirror write behind every earlier write for the SAME job.
   *
   * The snapshot is taken by the caller at patch time, so the queue holds the exact value
   * each patch produced, in order. `report` never throws, so the thunk handed to the queue
   * never rejects and the queue can chain it unconditionally.
   *
   * @param job - The snapshot this patch produced.
   * @param stackId - The Stack the row belongs to.
   */
  const enqueueMirror = (job: IngestJob, stackId: string): void => {
    queue.track(job.id, () => saveIngestJob(options.db, stackId, job).catch(report));
  };

  /** Persist whatever `inner` now holds for `id`, if it holds anything. */
  const mirror = (id: string): void => {
    const job: IngestJob | undefined = inner.get(id);
    if (job === undefined) return;
    enqueueMirror(job, stackIdOf(job));
  };

  return {
    create(source, now, stackId) {
      const job = inner.create(source, now, stackId);
      if (stackId !== undefined) stacksByJob.set(job.id, stackId);
      // The Stack comes from THIS call, not from the wrapper's construction: a wrapper
      // built for one Stack must still mirror a job the caller created in another.
      enqueueMirror(job, stackId ?? options.stackId);
      return job;
    },
    get(id) {
      return inner.get(id);
    },
    list() {
      return inner.list();
    },
    patchIngest(id, patch, now) {
      inner.patchIngest(id, patch, now);
      mirror(id);
    },
    patchCompile(id, patch, now) {
      inner.patchCompile(id, patch, now);
      mirror(id);
    },
    patchAttempts(id, attempts, now) {
      inner.patchAttempts(id, attempts, now);
      mirror(id);
    },
    clear() {
      inner.clear();
    },
    flushMirror(timeoutMs) {
      return queue.flush(timeoutMs ?? resolveMirrorFlushTimeoutMs());
    },
  };
}
