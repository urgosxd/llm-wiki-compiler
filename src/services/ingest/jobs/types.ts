/**
 * @file src/services/ingest/jobs/types.ts
 * @description The wire contract and observer contracts for an ASYNC ingest job.
 *
 * ## Why a job exists at all
 *
 * `POST /api/ingest` used to be the only way to ingest, and it runs to
 * completion: fetch, one Postgres transaction across both dimensions, then a full
 * wiki compile. For a large source that is minutes of work behind a single HTTP
 * response, and there is no persisted intermediate state anywhere -- progress
 * lives in `output.status()` on stdout and in a timing file no HTTP surface
 * reads. A UI could only show "waiting" and then either the result or a closed
 * socket.
 *
 * A job changes the question the caller asks. Instead of "did this five-minute
 * request succeed", it becomes "where is this upload right now, in each
 * dimension, and what did it try". That is what this file describes.
 *
 * ## TWO dimensions, deliberately not one `status`
 *
 * The temptation is a single `status: "running"` plus a single `stage`. That
 * shape cannot express the truth, because ingest and compile are separate
 * operations that fail SEPARATELY. The synchronous endpoint already proves it:
 * `compileBusy` exists precisely because a compile can fail while the source is
 * successfully ingested (`src/host/api.ts`).
 *
 * So a job carries {@link IngestDimensionState} and {@link CompileDimensionState}
 * as independent state machines. A job whose ingest succeeded and whose compile
 * is `busy` is a real, common state -- and collapsing it into one `failed` would
 * hide which half worked and whether a retry is needed at all.
 *
 * ## `ingest.unchanged` is NOT `ingest.succeeded`
 *
 * `writeStatus === "unchanged"` means a re-ingest of identical content wrote
 * nothing and journalled nothing (`src/services/ingest/service.ts`). Reporting
 * that as success would tell a UI a write happened when none did. It is a
 * distinct terminal state because it answers a different operator question.
 *
 * ## Progress cannot be invented, so there is no percentage field
 *
 * The requirement is explicit: report the real stage and an indeterminate
 * indicator rather than fabricate a percentage. The strongest way to honour that
 * is to make fabrication impossible at the type level.
 *
 * There is no `progress: number` anywhere in this file. Progress is
 * {@link JobProgress} -- a completed count and its total -- or `null`. A client
 * that wants a percentage divides; a client that receives `null` shows an
 * indeterminate bar. Nothing here can produce "60%" from a stage that never
 * counted anything, because nothing here stores a percentage.
 *
 * Today only two stages know a denominator: page generation (merged concepts to
 * generate) and finalize (pages written). Every other stage reports `null`, and
 * `test/services/ingest-job-types.test.ts` pins that.
 *
 * ## The same contract is the observer contract
 *
 * The reporter interfaces below are what the ingest and compile pipelines call as
 * they move. They are deliberately narrow -- advance a stage, publish a progress
 * pair, record an attempt -- so the pipeline keeps its own decisions and this
 * module owns only what an observer is allowed to know. A pipeline that reported
 * an outcome here would be mutating state through a telemetry seam.
 */

/** Terminal and non-terminal state of the ingest half of a job. */
export type IngestStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "unchanged"
  | "failed";

/**
 * Ordered steps of an ingest, as the pipeline actually performs them.
 *
 * These mirror the real call order in `src/services/ingest/service.ts`, not a
 * marketing summary of it: detect the source type, fetch/extract its content,
 * prepare each dimension, commit the transaction, run post-commit projections,
 * then append the journal entry.
 */
export type IngestStage =
  | "detecting"
  | "fetching"
  | "extracting"
  | "preparing"
  | "committing"
  | "projecting"
  | "journaling";

/** State of the compile half of a job. */
export type CompileStatus =
  | "skipped"
  | "busy"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

/**
 * Ordered steps of a compile.
 *
 * Every value here is an existing `timeStage(...)` stage string in
 * `src/compiler/index.ts` (kebab-cased to snake_case for the wire). Naming them
 * from the pipeline rather than inventing a friendlier vocabulary is what keeps
 * the reported stage honest: a stage that is not measured cannot be reported.
 */
export type CompileStage =
  | "detect_changes"
  | "extraction"
  | "page_generation"
  | "finalize"
  | "embeddings";

/**
 * A real, countable amount of work: `completed` of `total`.
 *
 * Absent (`null`) everywhere the pipeline does not know its denominator. See the
 * file overview for why no percentage is carried.
 */
export interface JobProgress {
  /** Units finished so far. Never greater than {@link JobProgress.total}. */
  readonly completed: number;
  /** Units this stage will process in total. Always positive. */
  readonly total: number;
}

/**
 * One attempt at a unit of work that can be retried.
 *
 * Populated ONLY from retries that already exist. Today that is the coordinator's
 * transaction loop, bounded by `MAX_TX_ATTEMPTS` in
 * `src/dimensions/coordinator.ts`. This feature adds no retry policy of its own;
 * it makes an existing one visible.
 */
export interface AttemptRecord {
  /** 1-based attempt number, matching the coordinator's loop counter. */
  readonly attempt: number;
  /** ISO-8601 timestamp when the attempt began. */
  readonly startedAt: string;
  /** ISO-8601 timestamp when the attempt settled. Absent while in flight. */
  readonly endedAt?: string;
  /**
   * Message of the error this attempt threw. Absent on success.
   *
   * A message, not an error object: this value is serialized to JSON for the
   * wire and for the durable failure log, so it must survive `JSON.stringify`.
   */
  readonly error?: string;
}

/** The ingest half of a job snapshot. */
export interface IngestDimensionState {
  readonly status: IngestStatus;
  /** The step reached. Absent only while `status` is `"queued"`. */
  readonly stage?: IngestStage;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /**
   * Transaction attempts in order. Empty until `stage` reaches `"committing"`,
   * since no retryable unit runs before the transaction opens.
   */
  readonly attempts: readonly AttemptRecord[];
  /** Human-facing detail for the current state. Presentation text only. */
  readonly message?: string;
  /** Message of the error that made this dimension fail. */
  readonly error?: string;
}

/** The compile half of a job snapshot. */
export interface CompileDimensionState {
  readonly status: CompileStatus;
  readonly stage?: CompileStage;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /**
   * Progress within {@link CompileDimensionState.stage}, or `null` when that
   * stage has no known denominator.
   */
  readonly progress: JobProgress | null;
  /**
   * Settled work counts that are real but cannot form a ratio.
   *
   * The embeddings stage embeds pages AND, separately, the chunks those pages
   * split into — one measured run turned 93 pages into 442 chunks. A single
   * {@link JobProgress} pair cannot carry both without inventing a merged number,
   * so the bar keeps the unit a caller can reason about (pages) and these counts
   * ride alongside as text.
   *
   * Absent, never zero. A consumer must not read a missing field as "zero chunks":
   * that is the same class of lie as a fabricated `progress`. Present-and-zero is
   * also never emitted, because a stage that embedded nothing did no work worth
   * naming.
   *
   * Never summed into, or compared against, {@link progress}. The two describe
   * different units, and a renderer that adds them would imply the bar is about
   * chunks.
   */
  readonly detail?: CompileDetail;
  readonly message?: string;
  readonly error?: string;
}

/**
 * Real cardinalities for a stage whose ratio cannot express them.
 *
 * Every field is optional and omitted rather than zeroed, for the reason
 * {@link CompileDimensionState.detail} documents.
 */
export interface CompileDetail {
  /** Chunk records embedded (or, at the end of the stage, settled). */
  readonly chunks?: number;
  /** Batched provider requests issued. */
  readonly requests?: number;
}

/** A complete job, as the wire sees it. Immutable: every transition replaces it. */
export interface IngestJob {
  /** Job identity, of the form `ing_<ULID>`. */
  readonly id: string;
  /** Source identity the job was created for. */
  readonly source: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the last transition. */
  readonly updatedAt: string;
  readonly ingest: IngestDimensionState;
  readonly compile: CompileDimensionState;
}

/**
 * 202 answer to an async ingest request.
 *
 * Carries the two dimensions at creation time so a client never has to make a
 * second request just to learn the job's identity and starting point.
 */
export interface IngestJobAccepted {
  readonly jobId: string;
  readonly status: IngestStatus;
  readonly stage: IngestStage | "queued";
  readonly ingest: IngestDimensionState;
  readonly compile: CompileDimensionState;
}

/** Advance the ingest dimension to a new stage. */
export interface IngestStageReporter {
  /** Record that the ingest pipeline entered `stage`. */
  stage(stage: IngestStage): void;
}

/**
 * Advance the compile dimension and publish its progress.
 *
 * `progress` is optional on {@link CompileProgressReporter.progress} callers and
 * always explicit here: a stage with no denominator reports `null` rather than
 * omitting the call, so "unknown" is a statement the pipeline makes on purpose.
 */
export interface CompileProgressReporter {
  /** Record that the compile pipeline entered `stage`. */
  stage(stage: CompileStage): void;
  /** Publish real `completed`/`total` counts for the current stage. */
  progress(progress: JobProgress | null): void;
  /**
   * Publish cardinalities the stage ratio cannot carry; see {@link CompileDetail}.
   *
   * `null` REMOVES the field rather than emptying it, so a cleared detail is
   * genuinely absent and a consumer can never mistake it for "zero chunks".
   */
  detail(detail: CompileDetail | null): void;
}

/**
 * Observe the coordinator's transaction attempts.
 *
 * Split from {@link IngestStageReporter} because attempts belong to ONE stage
 * (`committing`) and arrive in pairs, while stages advance one at a time.
 */
export interface AttemptReporter {
  /** Called immediately before attempt `attempt` opens its transaction. */
  attemptStarted(attempt: number, at: string): void;
  /**
   * Called once attempt `attempt` settles.
   *
   * @param errorMessage - The thrown message, or `undefined` when it succeeded.
   */
  attemptSettled(attempt: number, at: string, errorMessage?: string): void;
}

/**
 * Everything an ingest run may report, as one optional bundle.
 *
 * Optional as a whole rather than three separately-optional fields: a call site
 * either observes the run or does not, and three independent optionals would let
 * a caller pass attempts without stages and produce a job stuck at `queued` while
 * its transaction ran.
 */
export interface IngestJobObserver {
  readonly ingest: IngestStageReporter;
  readonly compile: CompileProgressReporter;
  readonly attempts: AttemptReporter;
}

/** Ingest dimension state for a job that has been created but not started. */
export function queuedIngestState(): IngestDimensionState {
  return { status: "queued", attempts: [] };
}

/** Compile dimension state for a job whose compile has not been decided yet. */
export function queuedCompileState(): CompileDimensionState {
  return { status: "queued", progress: null };
}
