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
import type { DimensionsPort } from "@repo/foundation";
import { IngestDimensionFailure } from "../../../dimensions/index.js";
import type { Dimension } from "../../../dimensions/index.js";
import {
  KNOWN_DIMENSIONS,
  enabledDimensionNames,
} from "../../../dimensions/activation.js";
import type { DimensionOutcome, DimensionRunReport } from "../../../dimensions/outcome.js";
import { describeDimensionMessage, describeDimensionOutcomes } from "../../../dimensions/report.js";
import type { DimensionName } from "../../../dimensions/types.js";
import { INGEST_DIMENSIONS, ingestSourceWithDimensions } from "../service.js";
import { buildIngestEnv } from "../ingest-env.js";
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
  /**
   * The configured dimensions, injected by the caller that owns the join.
   *
   * Forwarded, never resolved here: a background job runs after the HTTP response
   * that created it, so the dimensions have to travel ON the job exactly as the
   * Stack does. Absent means the ingest service resolves them internally, which is
   * what lets a job be run directly in a test; the api route that MINTS a job
   * requires a port before it creates one.
   */
  readonly dimensionsPort?: DimensionsPort<Dimension>;
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
    detail(detail) {
      // Passing `undefined` through deletes the field (see `mergeCompile`), which
      // is how a cleared detail becomes genuinely absent instead of empty.
      guarded(() => registry.patchCompile(jobId, { detail: detail ?? undefined }, clock()));
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
 * Record the report on the job, when there is one to record.
 *
 * Called BEFORE the settle that follows it, so the durable mirror -- which persists the
 * snapshot on the next transition -- writes a row that already carries the report. An
 * ABSENT report is not an empty one: the file-authority mode performed no dimension
 * commit, so it leaves the key off rather than inventing a reason per dimension.
 *
 * `undefined` is now the file-authority case ONLY. Every failure path records a report --
 * `failed` per dimension after a rollback, `not-attempted` per dimension when the run died
 * before the dimensions -- because a settling path that named no dimension is exactly the
 * silence that hid the original defect.
 *
 * @param registry - Store the job lives in.
 * @param jobId - Identity of the job being reported.
 * @param dimensions - The report, when the run produced one.
 * @param now - Clock, injected so a test can pin timestamps.
 */
function recordReport(
  registry: JobRegistry,
  jobId: string,
  dimensions: readonly DimensionOutcome[] | undefined,
  now: () => Date,
): void {
  if (dimensions === undefined) return;
  registry.patchDimensions(jobId, dimensions, now());
}

/**
 * The compile line a settled run reports.
 *
 * Derived from the report whenever there is one; the constant survives only for a run that
 * recorded no report at all -- the file-authority mode, which performs no dimension commit.
 * A constant is what the operator reported, so it is the fallback and never the answer.
 *
 * @param dimensions - The report the ingest half produced, when it produced one.
 * @returns The derived line, or the historical constant when nothing was measured.
 */
function compiledMessageOf(dimensions: readonly DimensionOutcome[] | undefined): string {
  return dimensions === undefined ? "Wiki compiled." : describeDimensionMessage(dimensions);
}

/**
 * The report of an ingest whose transaction ROLLED BACK.
 *
 * Every dimension the coordinator touched is reported `failed`, because after the rollback
 * none of their work exists. The naive mapping is the trap this exists to avoid:
 *
 *   - a `committed` run recorded before the rollback would map to `succeeded`, claiming
 *     work the transaction removed;
 *   - and it must never map to `declined`, whose clause reads "no changes" about work that
 *     was performed and then discarded.
 *
 * `enabled` is taken from the runs themselves because a failed run is the only evidence
 * left of which dimensions were resolved: a dimension the resolution never built has no run
 * record, and saying `disabled` about it without evidence would be a guess.
 *
 * @param error - The failure, carrying the per-run state the coordinator recorded.
 * @returns One `failed` outcome per dimension that was touched.
 */
function failedReportOf(error: IngestDimensionFailure): readonly DimensionOutcome[] {
  const runs: DimensionRunReport[] = error.dimensionRuns.map((run) => ({
    name: run.name,
    state: "failed",
    error: run.error ?? error.message,
  }));
  return describeDimensionOutcomes({
    route: INGEST_DIMENSIONS,
    enabled: runs.map((run) => run.name),
    runs,
  });
}

/**
 * The report of a run that failed BEFORE any dimension was resolved.
 *
 * The failure is upstream of the dimension work -- an unreadable source, lock contention --
 * so nothing can be said about any dimension beyond that fact. Every composed and enabled
 * dimension is therefore reported `not-attempted`, which is NOT one of the reasons that
 * describe a dimension the run resolved: `not-in-route` and `disabled` would blame the route
 * or the switch, and `declined` would claim it ran and found nothing to write.
 *
 * Route and switch are the CONFIGURED answers here, because no run record survived to say
 * otherwise: `INGEST_DIMENSIONS` is the route the async ingest composes, and
 * {@link enabledDimensionNames} is the same pure environment parse every other reader uses.
 * No database, no resolver, no Stack lookup -- this runs in a `catch`, after the work that
 * would have opened a connection has already failed.
 *
 * @param env - The environment this job ran under.
 * @returns One `not-attempted` entry per composed and enabled known dimension.
 */
function notAttemptedReportOf(env: NodeJS.ProcessEnv): readonly DimensionOutcome[] {
  return describeDimensionOutcomes({
    route: INGEST_DIMENSIONS,
    enabled: enabledNamesOf(env),
    runs: [],
    attempted: false,
  });
}

/**
 * The dimensions the switch enables, with a refusal that must not swallow the settle.
 *
 * `enabledDimensionNames` is a pure parse of one environment variable, so a file-backed stack
 * cannot make it throw. A MALFORMED value can: it refuses an unknown name with
 * `DimensionActivationError`, in the same words `resolveDimensions` raises. That refusal is
 * itself the failure this report is about, and letting it escape here would leave the job
 * `running` forever -- a reporting bug destroying the status it exists to explain. So the
 * report falls back to "every known dimension counts as enabled" and labels them
 * `not-attempted`: the truthful statement, since nothing was reached.
 *
 * @param env - The environment this job ran under.
 * @returns The enabled names, or every known name when the switch cannot be parsed.
 */
function enabledNamesOf(env: NodeJS.ProcessEnv): readonly DimensionName[] {
  try {
    return enabledDimensionNames(env);
  } catch {
    return [...KNOWN_DIMENSIONS];
  }
}

/**
 * The report of a run that is settling FAILED, whichever kind of failure it was.
 *
 * A rolled-back transaction already knows what each dimension did, so it reports each of them
 * `failed`. Any OTHER error died upstream of the dimensions, and a report is still required:
 * silence there is the defect that made an operator unable to tell an excluded dimension from
 * one that never ran. Both arms name every known dimension, which is the property that matters.
 *
 * @param error - What the run threw.
 * @param env - The environment this job ran under.
 * @returns One outcome per known dimension.
 */
function failureReportOf(error: unknown, env: NodeJS.ProcessEnv): readonly DimensionOutcome[] {
  return error instanceof IngestDimensionFailure
    ? failedReportOf(error)
    : notAttemptedReportOf(env);
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
  env: NodeJS.ProcessEnv,
  dimensions: readonly DimensionOutcome[] | undefined,
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
    const result = await compileAndReport(root, {
      jobObserver: jobObserverFor(registry, job.id, now),
      // Same env as the ingest half. Without it the source lands in the requested
      // Stack and its pages land in the bound one, which is the split this route
      // exists to prevent.
      env,
    });
    if (result.busy === true) {
      settleCompile(registry, job.id, "busy", "Another compile holds the lock; retry.", now());
      return undefined;
    }
    settleCompile(registry, job.id, "succeeded", compiledMessageOf(dimensions), now());
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
  await runIngestJobUnder(input);
}

/**
 * The job body.
 *
 * The Stack travels as an ENVIRONMENT computed from the job, never assigned into
 * `process.env`: the async route answers 202 before this runs, so a mutation here would
 * escape into whatever else the process is doing -- including another job.
 *
 * @param input - The job to run.
 */
async function runIngestJobUnder(input: RunJobInput): Promise<void> {
  const { registry, job, root } = input;
  const env = buildIngestEnv(input.stackId);
  const now = () => new Date();
  try {
    const ingested = await ingestSourceWithDimensions(
      root,
      job.source,
      jobObserverFor(registry, job.id, now),
      env,
      // The Stack travels in `env`, not as an argument: see `buildIngestEnv`.
      {},
      input.dimensionsPort,
    );
    recordReport(registry, job.id, ingested.dimensions, now);
    settleIngestFromResult(registry, job.id, ingested.result.writeStatus, now());
    await runCompileHalf(input, now, env, ingested.dimensions);
  } catch (error) {
    // The report is recorded BEFORE the settle, so the durable mirror that persists the next
    // transition already carries it. See `failureReportOf` for which report each failure gets.
    recordReport(registry, job.id, failureReportOf(error, env), now);
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
