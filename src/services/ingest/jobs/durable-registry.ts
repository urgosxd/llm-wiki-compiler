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
 */

import type { JobRegistry } from "./registry.js";
import type { IngestJob } from "./types.js";
import { saveIngestJob } from "./job-store.js";
import type { Database } from "llmwiki-kg";

/** What the wrapper needs beyond the registry it wraps. */
export interface DurableRegistryOptions {
  /** Handle used for the mirror. */
  readonly db: Database;
  /**
   * The Stack a job belongs to, when the caller names one.
   *
   * A function rather than a string because ONE host now serves several Stacks: the
   * request decides which, and the decision arrives with the job rather than with the
   * registry. Binding a single Stack here made `stackId` on `POST /api/ingest` a lie --
   * the live registry got the requested Stack while the durable row went to the host's
   * startup Stack, so reading the job back under the requested id returned 404.
   *
   * Absent, the host's bound Stack is used, which is the single-tenant behaviour.
   */
  readonly stackIdFor?: (job: IngestJob) => string | undefined;
  /** Tenant every job of this host belongs to, when none is named. */
  readonly stackId: string;
  /** Called when a mirror write fails. Never rethrown: see the file header. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Wrap a registry so its transitions are also durable.
 *
 * @param inner - The live registry the host already owns.
 * @param options - Database, tenant, and the error sink.
 * @returns A registry with the same contract and an added mirror.
 */
export function createDurableJobRegistry(
  inner: JobRegistry,
  options: DurableRegistryOptions,
): JobRegistry {
  const report = (error: unknown): void => {
    if (options.onError !== undefined) options.onError(error);
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

  /** The Stack this job belongs to: the caller's when named, else the bound one. */
  const stackIdOf = (job: IngestJob): string =>
    stacksByJob.get(job.id) ?? options.stackIdFor?.(job) ?? options.stackId;

  /** Persist whatever `inner` now holds for `id`, if it holds anything. */
  const mirror = (id: string): void => {
    const job: IngestJob | undefined = inner.get(id);
    if (job === undefined) return;
    void saveIngestJob(options.db, stackIdOf(job), job).catch(report);
  };

  return {
    create(source, now, stackId) {
      const job = inner.create(source, now, stackId);
      if (stackId !== undefined) stacksByJob.set(job.id, stackId);
      // The Stack comes from THIS call, not from the wrapper's construction: a host
      // that booted bound to A must still mirror a job the caller created in B.
      void saveIngestJob(options.db, stackId ?? options.stackId, job).catch(report);
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
  };
}
