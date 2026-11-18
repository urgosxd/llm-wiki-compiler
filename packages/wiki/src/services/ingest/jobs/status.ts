/**
 * @file src/services/ingest/jobs/status.ts
 * @description Why a job is where it is: the ONE place a status reason is derived.
 *
 * ## The gap this closes
 *
 * A job could answer `failed`, `busy`, or a `running` that had not moved for a day, and
 * none of those told an operator anything they could act on. The reporter's words for it
 * are "la informacion que da es muy pobre". Three different facts had to become legible,
 * and they are NOT the same fact:
 *
 *   - a terminal failure already carries its own error text in the stored row, and a
 *     reader must be handed it rather than having to know where to look;
 *   - `busy` is a SETTLED state (`isSettled` counts it) that nothing transitions onward,
 *     so it has to name the lock it never got and say a retry is the next step;
 *   - a row that is still non-terminal long past a named bound has to be reported as
 *     what it is — an inference from a stale timestamp, not a failure anyone observed.
 *
 * ## Why `kind` exists at all
 *
 * "The upload failed" and "the owning process may have stopped" send an operator to two
 * completely different places. A single `reason` string would let a client render both
 * the same, so every reason carries {@link JobStatusReason.kind} and a derived one can
 * never be mistaken for something the pipeline reported.
 *
 * ## Which claim wins: an OBSERVED fact outranks a DERIVED one
 *
 * A job can be both failed and silent — reproduction pair 3 is exactly that, an ingest
 * that recorded `ENOENT…` while its compile stayed `queued` and the row then sat for
 * hours. The operator asked why the job is where it is, and the pipeline has an answer;
 * a reader that answered "no progress since …" would be quoting this module's inference
 * over the recorded fact. So the headline order is:
 *
 *   0. a row a REAP carried off (`abandonedAt` present) — `kind: "derived"`. Its failure text
 *      was written by the reap, not by the pipeline: nobody observed a failure, so quoting it as
 *      one would be the opposite of the truth, and the marker is what decides that — never the
 *      wording of the sentence;
 *   1. an observed failure (ingest first, then compile) — `kind: "observed"`;
 *   2. an observed `busy` compile — `kind: "observed"`, with `retryable: true`;
 *   3. a derived stall for a row that is non-terminal by `isSettled` and silent past the
 *      bound — `kind: "derived"`;
 *   4. nothing, for a row that is working or that finished cleanly.
 *
 * Case 0 is why the marker exists at all. A reap SETTLES rows hours after the process that owned
 * them stopped (`reaper.ts`), so the row ends up carrying a recorded-looking failure that no
 * pipeline ever recorded. Text alone cannot distinguish that from a real one — and classifying by
 * matching the text would make the distinction depend on a wording nobody pins. So the conclusion
 * is stored as data (`IngestJob.abandonedAt`), and this module reads the data.
 *
 * The inference is never DISCARDED by that order: `stalledSince` rides in its own field
 * whenever the row is non-terminal and past the bound, so "it failed" and "and nothing
 * has touched it since" stay two facts a reader can act on separately. Folding them into
 * one sentence is what would make them indistinguishable.
 *
 * ## Why this is a module and not three inline branches
 *
 * Two surfaces answer a status read — the viewer route and the MCP tool, in different
 * processes — plus the reaper that will settle abandoned rows. A reason derived inside a
 * route handler is a reason the next surface re-derives differently. The bound is
 * exported ({@link resolveIngestJobStuckAfterMs}) for the same reason: the surface that
 * REPORTS a stuck row and the one that SETTLES it must be reading one number.
 *
 * ## Nothing here writes
 *
 * Every function is pure: the job is read, a snapshot is returned, and the stored row is
 * untouched. A status read that mutated a row or a counter would be a recovery action
 * disguised as reporting.
 */

import {
  INGEST_JOB_STUCK_AFTER_ENV_VAR,
  INGEST_JOB_STUCK_AFTER_MS_DEFAULT,
} from "../../../utils/constants.js";
import { isSettled } from "./registry.js";
import type { IngestJob, JobStatusReason } from "./types.js";

/**
 * What a `busy` compile reports, on every surface.
 *
 * Fixed rather than echoing the stored `compile.message`: two producers write that
 * message with different words for the same state, and a status surface whose
 * explanation of `busy` depends on which producer wrote the row is not an explanation.
 * The observed message stays in the payload beside it.
 *
 * Not exported: this module is the only place a reason is written, and a copy of the
 * sentence anywhere else is a copy that drifts.
 */
const BUSY_COMPILE_REASON =
  "The compile did not run: another mutation held the project lock. Retry to compile again.";

/** What a failed ingest reports when even its own error message is missing. */
const INGEST_FAILED_REASON = "The ingest failed.";

/** What a failed compile reports when even its own error message is missing. */
const COMPILE_FAILED_REASON = "The compile failed.";

/**
 * What a reaped row reports if the sentence the reap wrote is somehow absent.
 *
 * A fallback rather than a second wording of the reap's sentence: the writer's text names the
 * instant the row last moved, which this read cannot recompute (the row's `updatedAt` has since
 * become the reap instant), so the recorded text wins whenever it is there and this is only here
 * so a marker without text still says something true.
 */
const ABANDONED_FALLBACK_REASON = "The job was abandoned: the process that owned it stopped.";

/** The half of a derived reason that says what silence probably means. */
const STUCK_REASON_TAIL = "; the owning process may have stopped";

/** The clock and the bound a derived status is computed against. */
export interface JobStatusOptions {
  /** The instant this read is happening, so a bound is never compared to a hidden now. */
  readonly now: Date;
  /** Silence after which an unsettled job is reported stuck; see the resolver below. */
  readonly stuckAfterMs: number;
}

/**
 * The bound a job may go without progress before a read reports it stuck, in milliseconds.
 *
 * Same parsing rule as the shutdown-flush bound (`resolveMirrorFlushTimeoutMs`) and the
 * provider timeouts (`readTimeoutEnv`): unset, empty, non-numeric, zero and negative all
 * fall back to the named default rather than inventing a second convention. Exported so
 * the reaper that SETTLES abandoned rows reads the number the surfaces REPORT.
 *
 * @param env - Environment to read; defaults to this process's own.
 * @returns A positive bound in milliseconds.
 */
export function resolveIngestJobStuckAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INGEST_JOB_STUCK_AFTER_ENV_VAR]?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return INGEST_JOB_STUCK_AFTER_MS_DEFAULT;
  return Math.trunc(parsed);
}

/**
 * An observed failure's own text, or `undefined` when neither dimension failed.
 *
 * The ingest half wins over the compile half: when both failed, the ingest is the cause
 * and the compile never had content to work on, so reporting the compile's message would
 * name a consequence as the reason.
 *
 * @param job - The snapshot to read.
 * @returns The recorded error text, a fallback message, or `undefined`.
 */
function failureReasonOf(job: IngestJob): string | undefined {
  if (job.ingest.status === "failed") {
    return job.ingest.error ?? job.ingest.message ?? INGEST_FAILED_REASON;
  }
  if (job.compile.status === "failed") {
    return job.compile.error ?? job.compile.message ?? COMPILE_FAILED_REASON;
  }
  return undefined;
}

/**
 * True when `job` is non-terminal by `isSettled` and has been silent past the bound.
 *
 * Silence is only news once it exceeds the bound, and only for a row that is NOT settled:
 * a settled row is finished, and calling a finished job stalled would be the same class of
 * lie as omitting the stall for a live one. A timestamp this module cannot parse is never
 * evidence of anything, so it yields `false` rather than a spurious stall.
 *
 * This is the ONE place the bound is compared. A status read and the delete that clears a
 * stuck row both ask THIS question, so the surface that reports a stall and the surface
 * that acts on one can never disagree about which rows have stalled.
 *
 * @param job - The snapshot to classify.
 * @param options - Clock and bound.
 * @returns True when the row is past the bound and may be treated as stuck.
 */
export function isStalled(job: IngestJob, options: JobStatusOptions): boolean {
  if (isSettled(job)) return false;
  const lastProgress = Date.parse(job.updatedAt);
  if (!Number.isFinite(lastProgress)) return false;
  return options.now.getTime() - lastProgress > options.stuckAfterMs;
}

/**
 * The instant the row last moved, when it has been silent past the bound; else `undefined`.
 *
 * @param job - The snapshot to read.
 * @param options - Clock and bound.
 * @returns The snapshot's `updatedAt`, or `undefined` while the row may still be working.
 */
function stalledSinceOf(job: IngestJob, options: JobStatusOptions): string | undefined {
  return isStalled(job, options) ? job.updatedAt : undefined;
}

/**
 * The conclusion a REAP recorded, when this row carries one.
 *
 * Read from `abandonedAt` and NOT from the sentence: an inference and an observation can carry
 * the same words, so the distinction has to be data rather than a match on prose. A row without
 * the marker is a row some pipeline really settled, and `undefined` leaves that to the branches
 * below.
 *
 * @param job - The snapshot to read.
 * @returns The derived reason, or `undefined` when this row was not reaped.
 */
function abandonedConclusionOf(job: IngestJob): JobStatusReason | undefined {
  if (job.abandonedAt === undefined) return undefined;
  return { reason: failureReasonOf(job) ?? ABANDONED_FALLBACK_REASON, kind: "derived" };
}

/**
 * Explain a job's current state, or decline to when it needs no explanation.
 *
 * A reaped row comes first: its "failure" is this system's inference, so it must not be quoted as
 * something a pipeline saw. After that, observed facts outrank the rest — see this file's header
 * for the order and for why a failure beats the inference that the row also stopped moving.
 *
 * @param job - The snapshot to describe.
 * @param options - Clock and bound.
 * @returns The reason, with its provenance, or `undefined` for a job that is working or
 *   that finished cleanly — those need no explanation, and inventing one would be the
 *   same defect as omitting a needed one.
 */
export function describeJobStatus(
  job: IngestJob,
  options: JobStatusOptions,
): JobStatusReason | undefined {
  const abandoned = abandonedConclusionOf(job);
  if (abandoned !== undefined) return abandoned;
  const failure = failureReasonOf(job);
  if (failure !== undefined) return { reason: failure, kind: "observed" };
  if (job.compile.status === "busy") return { reason: BUSY_COMPILE_REASON, kind: "observed" };
  const stalledSince = stalledSinceOf(job, options);
  if (stalledSince === undefined) return undefined;
  return { reason: `no progress since ${stalledSince}${STUCK_REASON_TAIL}`, kind: "derived" };
}

/** True when `value` carries the four fields every stored job snapshot has. */
function isJobSnapshot(value: unknown): value is IngestJob {
  const candidate = value as
    | { id?: unknown; source?: unknown; ingest?: { status?: unknown }; compile?: { status?: unknown } }
    | null;
  return candidate !== null
    && typeof candidate === "object"
    && typeof candidate.id === "string"
    && typeof candidate.source === "string"
    && typeof candidate.ingest?.status === "string"
    && typeof candidate.compile?.status === "string";
}

/**
 * Attach this read's explanation to a job, without touching the snapshot it was given.
 *
 * Returns the SAME value when there is nothing to add, so a caller can tell an explained
 * row from an unexplained one by identity if it needs to, and a durable reader's payload
 * is never rebuilt just to be handed back unchanged.
 *
 * @param job - Whatever the read produced; non-snapshots pass through untouched.
 * @param options - Clock and bound.
 * @returns The job as the wire should see it.
 */
export function withStatusReason<T>(job: T, options: JobStatusOptions): T {
  if (!isJobSnapshot(job)) return job;
  const reason = describeJobStatus(job, options);
  const stalledSince = stalledSinceOf(job, options);
  const compile = job.compile.status === "busy" ? { ...job.compile, retryable: true } : job.compile;
  if (reason === undefined && stalledSince === undefined && compile === job.compile) return job;
  const view: IngestJob = {
    ...job,
    compile,
    ...(reason === undefined ? {} : { statusReason: reason }),
    ...(stalledSince === undefined ? {} : { stalledSince }),
  };
  return view as T;
}
