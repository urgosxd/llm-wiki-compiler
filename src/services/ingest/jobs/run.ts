/**
 * @file src/services/ingest/jobs/run.ts
 * @description Runs one async ingest job to completion in the background, keeping
 * the job record in step with what the pipeline is actually doing.
 *
 * ## The job is a VIEW of the pipeline, never a second pipeline
 *
 * Every transition recorded here is caused by the real work: the ingest service
 * advancing through its own stages, the coordinator's transaction attempts, the
 * compile's `timeStage` boundaries. This module adds no work of its own and makes
 * no decision the pipeline would otherwise make. That property is what makes the
 * status trustworthy -- a job reported from a parallel model would eventually
 * describe something the pipeline never did.
 *
 * ## An observer must never fail the run it observes
 *
 * The reporter passed into the pipeline is wrapped so that a throwing observer is
 * swallowed. The alternative -- letting a status bug abort an ingest -- would mean
 * the observability feature can destroy the data path it exists to explain. The
 * wrap is why `service.ts` and `coordinator.ts` call their hooks directly: they
 * are the only two places that must not be defensive, and this module is where the
 * one guard lives.
 *
 * ## Why the two dimensions settle independently
 *
 * The ingest and the compile are separate operations with separate failures. When
 * the ingest succeeds and the compile fails, the job records BOTH: the source is on
 * disk and the wiki is stale. Reporting one `failed` would send an operator to
 * retry an upload that already landed.
 */

import { LockBusyError } from "../../../utils/lock.js";
import { compileAndReport } from "../../../compiler/index.js";
import { ingestSource } from "../service.js";
import { AKS_STACK_ID_ENV_VAR } from "../../../dimensions/activation.js";
import { recordJobFailure } from "./failure-log.js";
import type { JobRegistry } from "./registry.js";
import type {
  AttemptRecord,
  CompileProgressReporter,
  IngestJob,
  IngestJobObserver,
  IngestStageReporter,
} from "./types.js";

/** What one async run needs: the project, the registry, and the job identity. */
export interface RunJobInput {
  readonly root: string;
  readonly registry: JobRegistry;
  readonly job: IngestJob;
  /** Whether to compile after ingesting. Mirrors the synchronous endpoint's flag. */
  readonly compile: boolean;
  /**
   * Stack this job writes into, when it is not the one the process was started with.
   *
   * A job runs in the background, AFTER the HTTP response is answered, so the Stack
   * cannot be read from the request any more. It has to travel on the job: without it
   * every async ingest lands in whichever Stack the host booted with, and the caller
   * reads back an empty Stack with no error to explain it.
   */
  readonly stackId?: string;
}

/** Swallow an observer call's failure; a status bug must not fail the ingest. */
function guarded(work: () => void): void {
  try {
    work();
  } catch {
    // Deliberately swallowed. See the file overview.
  }
}

/**
 * Build the reporter bundle that writes observed progress into `job`'s record.
 *
 * @param registry - Store the job lives in.
 * @param jobId - Identity of the job being reported.
 * @param clock - ISO-8601 clock, injected so a test can pin timestamps.
 * @returns Reporters for the ingest pipeline and the compile.
 */
function jobObserverFor(
  registry: JobRegistry,
  jobId: string,
  clock: () => Date,
): IngestJobObserver {
  const attempts: AttemptRecord[] = [];

  const ingest: IngestStageReporter = {
    stage(stage) {
      guarded(() => registry.patchIngest(jobId, { status: "running", stage }, clock()));
    },
  };

  const compile: CompileProgressReporter = {
    stage(stage) {
      guarded(() => registry.patchCompile(jobId, { status: "running", stage }, clock()));
    },
    progress(progress) {
      guarded(() => registry.patchCompile(jobId, { progress }, clock()));
    },
  };

  return {
    ingest,
    compile,
    attempts: {
      attemptStarted(attempt, at) {
        guarded(() => {
          attempts.push({ attempt, startedAt: at });
          registry.patchAttempts(jobId, [...attempts], clock());
        });
      },
      attemptSettled(attempt, at, errorMessage) {
        guarded(() => {
          const index = attempts.findIndex((entry) => entry.attempt === attempt);
          if (index === -1) return;
          const settled: AttemptRecord = errorMessage === undefined
            ? { ...attempts[index], endedAt: at }
            : { ...attempts[index], endedAt: at, error: errorMessage };
          attempts[index] = settled;
          registry.patchAttempts(jobId, [...attempts], clock());
        });
      },
    },
  };
}

/**
 * Settle the ingest dimension from the result the service returned.
 *
 * `unchanged` is its own terminal state rather than `succeeded`: a re-ingest of
 * identical content wrote nothing, and a UI that showed "succeeded" would claim a
 * write that never happened.
 */
function settleIngestFromResult(
  registry: JobRegistry,
  jobId: string,
  writeStatus: string | undefined,
  now: Date,
): void {
  const unchanged = writeStatus === "unchanged";
  registry.patchIngest(
    jobId,
    {
      status: unchanged ? "unchanged" : "succeeded",
      endedAt: now.toISOString(),
      message: unchanged ? "Content unchanged; nothing was written." : "Source ingested.",
    },
    now,
  );
}

/** Record a compile outcome on the compile dimension. */
function settleCompile(
  registry: JobRegistry,
  jobId: string,
  status: "succeeded" | "busy" | "failed",
  message: string,
  now: Date,
  error?: string,
): void {
  registry.patchCompile(
    jobId,
    {
      status,
      endedAt: now.toISOString(),
      progress: null,
      message,
      ...(error === undefined ? {} : { error }),
    },
    now,
  );
}

/**
 * Run the compile half and record its outcome, including the `busy` case.
 *
 * `busy` is not a failure: the compile never started because another mutation holds
 * the lock, so the source IS ingested and only the compile needs a retry. Giving it
 * its own status is what stops a client from re-uploading a source that landed.
 *
 * @returns The error when the compile failed, otherwise `undefined`.
 */
async function runCompileHalf(
  input: RunJobInput,
  now: () => Date,
): Promise<unknown> {
  const { registry, job, root } = input;
  if (!input.compile) {
    registry.patchCompile(
      job.id,
      { status: "skipped", progress: null, message: "Compile skipped on request." },
      now(),
    );
    return undefined;
  }
  try {
    const result = await compileAndReport(root, { jobObserver: jobObserverFor(registry, job.id, now) });
    if (result.busy === true) {
      settleCompile(registry, job.id, "busy", "Another compile holds the lock; retry.", now());
      return undefined;
    }
    settleCompile(registry, job.id, "succeeded", "Wiki compiled.", now());
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settleCompile(registry, job.id, "failed", "Compile failed.", now(), message);
    return error;
  }
}

/**
 * Run one job end to end, updating its record as it goes.
 *
 * Resolves rather than rejecting: this runs detached from the HTTP response that
 * created it, so there is no caller to reject to. Every failure is recorded on the
 * job and, when the job ends failed, in the durable failure log.
 *
 * @param input - Project root, registry, job identity, and whether to compile.
 */
export async function runIngestJob(input: RunJobInput): Promise<void> {
  if (input.stackId === undefined) return runIngestJobUnder(input);
  const saved = process.env[AKS_STACK_ID_ENV_VAR];
  process.env[AKS_STACK_ID_ENV_VAR] = input.stackId;
  try {
    return await runIngestJobUnder(input);
  } finally {
    if (saved === undefined) delete process.env[AKS_STACK_ID_ENV_VAR];
    else process.env[AKS_STACK_ID_ENV_VAR] = saved;
  }
}

/**
 * The job body, run with the Stack already applied.
 *
 * Split from {@link runIngestJob} so the Stack save/restore wraps exactly one call
 * site instead of nesting the whole pipeline in a `try`.
 *
 * @param input - The job to run.
 */
async function runIngestJobUnder(input: RunJobInput): Promise<void> {
  const { registry, job, root } = input;
  const now = () => new Date();
  try {
    const ingested = await ingestSource(root, job.source, jobObserverFor(registry, job.id, now));
    settleIngestFromResult(registry, job.id, ingested.writeStatus, now());
    await runCompileHalf(input, now);
  } catch (error) {
    // Lock contention is the caller's retry signal, not a failure of the source:
    // nothing was written, so `failed` with the reason is the honest record.
    const busy = error instanceof LockBusyError;
    registry.patchIngest(
      job.id,
      {
        status: "failed",
        endedAt: now().toISOString(),
        error: busy
          ? "Another mutation holds the project lock; retry."
          : error instanceof Error ? error.message : String(error),
      },
      now(),
    );
    settleCompileWithoutIngest(registry, job.id, busy, now);
  }
  await recordIfFailed(root, registry, job.id);
}

/**
 * Settle the compile half when the ingest never produced anything to compile.
 *
 * ## Why leaving it `queued` is a defect, not a neutral default
 *
 * The compile starts only after a successful ingest, so an ingest that throws means
 * no compile will ever run. Leaving it at `queued` is a claim that work is pending,
 * and nothing will ever advance it. Two consequences, both measured:
 *
 *   - A client polling the job sees `compile: queued` with a FROZEN `updatedAt`
 *     forever. A UI reasonably renders a moving "working" indicator for that — the
 *     one thing a status endpoint must never cause — for a job that is dead.
 *   - `isSettled` in `registry.ts` requires the compile to be terminal, so the job
 *     can never be evicted from the registry either. An ingest-failed job would pin
 *     a slot against the retention bound for the life of the process.
 *
 * `skipped` is the honest terminal state: it never ran, and it never will. It is NOT
 * `failed`, because the compile did not fail — the distinction is what tells a user
 * whether to wait or to act. Lock contention is reported as `busy` instead, matching
 * how a compile that could not start for the same reason is already recorded.
 *
 * @param registry - The registry the job lives in.
 * @param jobId - The job whose ingest failed.
 * @param busy - True when the failure was lock contention rather than the source.
 * @param now - Clock, so the settled timestamp matches the ingest's.
 */
function settleCompileWithoutIngest(
  registry: JobRegistry,
  jobId: string,
  busy: boolean,
  now: () => Date,
): void {
  const message = busy
    ? "Compile did not start: another mutation held the project lock."
    : "Compile never started: the ingest failed, so there was nothing to compile.";
  registry.patchCompile(
    jobId,
    { status: busy ? "busy" : "skipped", progress: null, message },
    now(),
  );
}

/** Append the durable failure record when the settled job ended failed. */
async function recordIfFailed(root: string, registry: JobRegistry, jobId: string): Promise<void> {
  const settled = registry.get(jobId);
  if (settled === undefined) return;
  const failed = settled.ingest.status === "failed" || settled.compile.status === "failed";
  if (!failed) return;
  await recordJobFailure(root, settled);
}
