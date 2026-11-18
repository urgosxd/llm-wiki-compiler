/**
 * @file src/dimensions/coordinator.ts
 * @description Runs one ingest across every enabled dimension in ONE Postgres
 * transaction, retried up to two attempts, so a failure leaves neither dimension
 * ahead of the other.
 *
 * ## The ordering rule is gone, and that is the point
 *
 * The previous shape committed `wiki` first and `kg` second, because the wiki write
 * was a local file that could be reverted and the graph write was remote. That
 * rationale expired twice over: `wiki` writes rows now, and both dimensions write
 * to the SAME database -- `wiki.pages`, `wiki.source_documents` and
 * `stack_documents` are three tables of one database reached through one pooled
 * client.
 *
 * Inside one transaction atomicity is the transaction's guarantee, so order is free
 * in that respect. It is NOT free as an observable property: the required flow is
 * `ingest -> compile wiki -> compile kg`, so the coordinator puts the dimensions in
 * canonical order before it touches any of them instead of trusting the caller's
 * array (see {@link orderCanonically}). What the coordinator owns instead:
 *
 *   1. **The transaction.** It opens it, binds the Stack on it, and hands it to
 *      every dimension through `CommitScope`. A dimension that opens its own
 *      connection silently breaks atomicity, which is the one rule the port states.
 *      This is the SOLE mechanism: if the transaction commits, every dimension's
 *      rows are there; if it rolls back, none of them are.
 *   2. **The retry.** Up to {@link MAX_TX_ATTEMPTS} attempts of the SAME
 *      transaction body, reusing the prepared handles. Retrying the handles rather
 *      than the run is what keeps a retry free: `prepare` is where the provider
 *      calls live, and it does not run twice.
 *   3. **The failure record.** One structured line on stderr, written after the
 *      rollback. See below.
 *
 * ## Why there is no ingest outbox any more
 *
 * Until this change a durable `ingest_outbox` row was written before the commit so
 * an interrupted run could be finished later by a reconciler at startup. It was
 * removed because, measured against the code, it had stopped carrying any
 * guarantee:
 *
 *   - The row was written INSIDE this transaction, so a rollback erased it. A v3
 *     run could not leave a `pending` row at all; the only `pending` rows in
 *     existence predate the single transaction.
 *   - The startup reconciler's outcome was discarded by its caller, and no CLI
 *     command or endpoint read it, so a `pending` row had no reader.
 *   - The row stored a full copy of every document and body, and only the
 *     reconciler swept `committed` rows -- a CLI-only project never would.
 *   - `failed` rows were written with `on conflict (ingest_id) do update`, so on an
 *     ambiguous commit a row that HAD landed could be relabelled `failed` and never
 *     replayed.
 *   - A replay re-ran `prepare`, which is exactly where the embeddings and
 *     extraction provider calls live.
 *
 * So the table, the reconciler, the startup hook and the full-text copy are gone.
 * The facts a `failed` row used to carry now go to stderr as one JSON object, where
 * an operator already looks.
 *
 * ## What each failure does
 *
 *   - a `prepare` throws                       -> nothing committed, nothing logged;
 *                                                 the caller's own error is the
 *                                                 diagnostic.
 *   - the transaction throws on attempt 1      -> rolled back, retried.
 *   - the transaction throws on both attempts  -> rolled back, one structured line
 *                                                 on stderr, error rethrown. Nothing
 *                                                 landed: the source file was never
 *                                                 touched, since the projection runs
 *                                                 after a commit.
 *   - an `afterCommit` throws                  -> the transaction HAS committed;
 *                                                 rows stay, the projection reports,
 *                                                 error rethrown.
 *   - the process dies at any point            -> the transaction never committed,
 *                                                 so Postgres leaves nothing behind.
 */

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import type { AfterCommitEffect, CommittedWrite, Dimension, DimensionInput, PreparedWrite } from "./types.js";
import { KNOWN_DIMENSIONS } from "./activation.js";
import type { DimensionRunReport } from "./report.js";
import type { AttemptReporter } from "../services/ingest/jobs/types.js";

/** How many times the transaction body is attempted before the ingest fails. */
const MAX_TX_ATTEMPTS = 2;

/**
 * Value of the `event` field on the failure line.
 *
 * Stable and explicit so a log query can select one shape rather than matching on
 * prose, which is the only reason the field exists alongside `outcome`.
 */
const INGEST_FAILED_EVENT = "ingest_failed";

/** One dimension's progress across the whole run. */
interface DimensionRun {
  readonly dimension: Dimension;
  prepared: PreparedWrite | null;
  committed: CommittedWrite | null;
  /**
   * Message of the error this dimension threw, once it threw one.
   *
   * Recorded so the report can name the dimension that ACTUALLY failed instead of
   * blaming every dimension the rollback touched, and cleared at the start of each
   * transaction attempt so a retry that succeeds leaves no stale failure behind.
   */
  failure: string | undefined;
}

/**
 * Optional observation hooks for one ingest run.
 *
 * Optional as a WHOLE, with every member optional individually, because the only
 * thing that must never happen is a caller passing attempts without a clock: a run
 * would then record timestamps from a source the caller cannot control. The CLI and
 * the MCP server pass nothing at all and behave exactly as before.
 *
 * Nothing here can change the run's outcome. An observer that throws is the
 * observer's bug, not the ingest's failure, and `service.ts` is what guarantees
 * that by wrapping every call.
 */
export interface IngestDimensionsOptions {
  /** Observe the transaction's retry attempts. */
  readonly attempts?: AttemptReporter;
  /** ISO-8601 clock, injected so a test can pin attempt timestamps. */
  readonly now?: () => string;
}

/** Result of a successful two-dimension ingest. */
export interface IngestOutcome {
  /** What each dimension reported, keyed by dimension name. */
  readonly summaries: ReadonlyMap<string, string>;
  /**
   * File-write outcome reported by a dimension, if any has one.
   *
   * `ingest` surfaces created / updated / unchanged to its caller, and only a
   * file-backed dimension knows it. Kept separate from `summaries` so callers do
   * not parse presentation text to recover a behavioural value.
   */
  readonly writeStatus?: "created" | "updated" | "unchanged";
  /** Path the file-backed dimension wrote, when one did. */
  readonly artifactPath?: string;
  /**
   * Per-dimension state for this run, one record per dimension it touched.
   *
   * This is the fact the report is derived from, and the reason it exists: a
   * summary can only say "committed", so `summaries` alone cannot tell a dimension
   * that never ran from one that threw. `summaries` stays beside it unchanged for
   * the callers that already read it.
   */
  readonly dimensionRuns: readonly DimensionRunReport[];
}

/**
 * A failed ingest that carries the per-dimension state it recorded.
 *
 * After the rollback the rows are gone, so the only thing left to hand an operator
 * is WHICH dimension threw and what it said. The message and the `cause` are
 * unchanged from the bare `Error` this replaces, so a caller that reads either keeps
 * working; {@link dimensionRuns} is the addition.
 */
export class IngestDimensionFailure extends Error {
  constructor(
    message: string,
    options: { cause?: unknown },
    readonly dimensionRuns: readonly DimensionRunReport[],
  ) {
    super(message, options);
    this.name = "IngestDimensionFailure";
  }
}

/**
 * Undo the `prepare` of every dimension that will not commit.
 *
 * Only `prepare` is undone, and that is now the whole story: the dimensions inside
 * one transaction already had their writes rolled back by Postgres, so there is
 * nothing visible left to compensate. What `discard` still covers is a dimension
 * whose `prepare` allocated something OUTSIDE the transaction -- a staged upload, a
 * temp file -- which neither shipped dimension does today but the port allows.
 *
 * A dimension whose `commit` reported success is NOT trusted here. Nothing in the
 * port promises a `discard` reverts a visible write, so a quiet return is recorded
 * as unresolved rather than read as a clean rollback. That misreading once deleted
 * the only record of a half-applied ingest.
 *
 * @param runs - Every dimension this ingest touched.
 * @returns Names of dimensions whose committed work may still be visible.
 */
async function discardPreparedWrites(
  runs: readonly DimensionRun[],
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const run of [...runs].reverse()) {
    if (run.prepared === null) continue;
    try {
      await run.dimension.discard(run.prepared);
      if (run.committed !== null) unresolved.push(run.dimension.name);
    } catch {
      unresolved.push(run.dimension.name);
    }
  }
  return unresolved;
}

/**
 * Run every dimension's commit inside ONE transaction, binding the tenant first.
 *
 * The bind happens HERE rather than in each dimension because the coordinator is
 * the party that knows the Stack and owns the transaction. `set_config(..., true)`
 * is transaction-local, so it cannot leak onto the pooled connection afterwards,
 * and both dimensions may re-bind the same value harmlessly.
 *
 * @param db - Pooled handle used to open the transaction.
 * @param stackId - Stack every dimension is bound to.
 * @param runs - Dimensions to commit, in order.
 * @throws When any dimension fails; the transaction rolls back as a unit.
 */
async function commitInOneTransaction(
  db: DatabaseHandle,
  stackId: string,
  runs: readonly DimensionRun[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const scope = { tx: tx as unknown };
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    for (const run of runs) {
      // `prepare` assigns before this loop, so the guard is defensive.
      if (run.prepared === null) continue;
      try {
        run.committed = await run.dimension.commit(run.prepared, scope);
      } catch (error) {
        // Recorded and rethrown immediately: control flow, retry count and which
        // dimensions run are unchanged, only the post-mortem gains a fact.
        run.failure = errorMessageOf(error);
        throw error;
      }
    }
  });
}

/**
 * Attempt the transaction until it succeeds or the attempts run out.
 *
 * The SAME handles are reused on every attempt, which is what makes a retry cheap:
 * `prepare` holds the chunking, embeddings and extraction, and none of it re-runs.
 * A caller that retried the whole run instead would pay the provider twice to guard
 * a failure the second attempt may not even have.
 *
 * @param db - Pooled handle.
 * @param stackId - Stack every dimension is bound to.
 * @param runs - Dimensions to commit.
 * @throws The LAST attempt's error, after every attempt rolled back.
 */
async function attemptWithRetry(
  db: DatabaseHandle,
  stackId: string,
  runs: readonly DimensionRun[],
  attempts: AttemptReporter | undefined,
  now: () => string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt += 1) {
    // A failed attempt leaves partial `committed` values behind; clearing them
    // keeps the post-mortem honest about what actually landed (nothing). The
    // failure message is cleared with them: an attempt that threw followed by a
    // retry that succeeds must report the SECOND outcome, not the first.
    for (const run of runs) {
      run.committed = null;
      run.failure = undefined;
    }
    attempts?.attemptStarted(attempt, now());
    try {
      await commitInOneTransaction(db, stackId, runs);
      attempts?.attemptSettled(attempt, now());
      return;
    } catch (error) {
      attempts?.attemptSettled(attempt, now(), errorMessageOf(error));
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Reduce a thrown value to the message a job record can serialize.
 *
 * A job record travels as JSON, so it cannot carry the error OBJECT; the message
 * is the part an operator reads and the only part that survives the wire.
 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Report a rolled-back ingest as ONE structured line on stderr.
 *
 * This replaces the `failed` outbox row, which was written after the rollback for
 * exactly this purpose and then read by nobody. The same facts go to stderr as one
 * JSON object per line so an operator can grep for the source that never appeared.
 *
 * Must not throw: the caller is already handling the real failure, and replacing it
 * with a logging error would hide the cause. A line that cannot be written costs
 * the diagnostic, not the error.
 *
 * @param input - Source identity the dimensions were given.
 * @param runs - Dimensions this ingest attempted, in commit order.
 * @param reason - The last attempt's error message.
 */
function reportIngestFailure(
  input: DimensionInput,
  runs: readonly DimensionRun[],
  reason: string,
): void {
  const line = JSON.stringify({
    event: INGEST_FAILED_EVENT,
    outcome: "failed",
    source: input.source,
    dimensions: runs.map((run) => run.dimension.name),
    attempts: MAX_TX_ATTEMPTS,
    error: reason,
  });
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Intentionally swallowed; see the doc comment.
  }
}

/**
 * Run the post-commit projections and merge what they report.
 *
 * A projection failure is NOT an ingest failure in the sense of "nothing landed":
 * the transaction committed, so the rows are real. It is still thrown, because a
 * caller that received no saved path would otherwise believe the source is on disk.
 *
 * The scope handed to a projection carries `tx: undefined` on purpose: it runs after
 * the transaction committed, so there is no live handle to give it. A projection
 * that needs to write rows must say so and join the transaction instead; the one
 * shipped projection writes a file and ignores the scope.
 *
 * @param runs - Dimensions whose commits reported an `afterCommit` effect.
 * @returns The artifact path and write status the projections produced, if any.
 */
async function runProjections(
  runs: readonly DimensionRun[],
): Promise<AfterCommitEffect> {
  const scope = { tx: undefined };
  let artifactPath: string | undefined;
  let writeStatus: AfterCommitEffect["writeStatus"];
  for (const run of runs) {
    const effect = await run.committed?.afterCommit?.(scope);
    if (effect == null) continue;
    artifactPath ??= effect.artifactPath;
    writeStatus ??= effect.writeStatus;
  }
  return {
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(writeStatus === undefined ? {} : { writeStatus }),
  };
}

/**
 * Prepare every dimension, undoing what was prepared if any of them throws.
 *
 * NOTHING WAS EVER WRITTEN when this fails: `prepare` runs before the transaction
 * opens, so there is no row to remove and no work to retry. Only a dimension that
 * allocated something OUTSIDE the transaction needs its `discard`.
 *
 * @param runs - Dimensions to prepare, in commit order.
 * @param input - Source identity every dimension is prepared for.
 * @throws The preparing dimension's own error, unwrapped: it is the diagnostic.
 */
async function prepareEveryDimension(
  runs: readonly DimensionRun[],
  input: DimensionInput,
): Promise<void> {
  let preparing: DimensionRun | undefined;
  try {
    for (const run of runs) {
      preparing = run;
      run.prepared = await run.dimension.prepare(input);
    }
  } catch (error) {
    // The dimension that threw is the one to name; the others were only prepared.
    if (preparing !== undefined) preparing.failure = errorMessageOf(error);
    await discardPreparedWrites(runs);
    throw error;
  }
}

/**
 * Commit the run, and on failure clean up, report, and rethrow with context.
 *
 * The thrown message keeps the attempt count and the unresolved suffix because
 * callers and tests read both: "it failed twice" and "this dimension may still be
 * visible" are different facts and collapsing them costs the second one.
 *
 * @param db - Pooled handle used to open the transaction.
 * @param stackId - Stack every dimension is bound to.
 * @param runs - Dimensions to commit, in order.
 * @param input - Source identity, for the failure line.
 * @throws The last attempt's error, wrapped with the attempt count.
 */
async function commitOrReport(
  db: DatabaseHandle,
  stackId: string,
  runs: readonly DimensionRun[],
  input: DimensionInput,
  attempts: AttemptReporter | undefined,
  now: () => string,
): Promise<void> {
  try {
    await attemptWithRetry(db, stackId, runs, attempts, now);
  } catch (error) {
    const unresolved = await discardPreparedWrites(runs);
    const reason = error instanceof Error ? error.message : String(error);
    reportIngestFailure(input, runs, reason);
    const names = unresolved.length === 0 ? "" : ` (unresolved: ${unresolved.join(", ")})`;
    throw new IngestDimensionFailure(
      `ingest failed after ${MAX_TX_ATTEMPTS} attempts: ${reason}${names}`,
      { cause: error },
      runReportsOf(runs),
    );
  }
}

/**
 * Collect what each dimension that reported a commit said about itself.
 *
 * A dimension whose commit never returned has nothing to report, and is skipped
 * rather than given an empty summary: an entry here means work landed.
 *
 * Kept exactly as it was after the per-run record arrived: it is one field of the
 * outcome beside {@link IngestOutcome.dimensionRuns}, not a thing the report is
 * derived from, and its readers keep their shape.
 *
 * @param runs - Dimensions this ingest attempted.
 * @returns Summaries keyed by dimension name.
 */
function summariesOf(runs: readonly DimensionRun[]): Map<string, string> {
  const summaries = new Map<string, string>();
  for (const run of runs) {
    if (run.committed === null) continue;
    summaries.set(run.dimension.name, run.committed.summary);
  }
  return summaries;
}

/**
 * Canonical position of one dimension.
 *
 * A name this build does not know sorts last, which keeps the order total without
 * starting to throw from a sort: the environment switch is where an unknown name is
 * refused, and it refuses before any dimension is built.
 *
 * @param dimension - Dimension to rank.
 * @returns Its index in {@link KNOWN_DIMENSIONS}, or one past the end.
 */
function rankOf(dimension: Dimension): number {
  const rank = KNOWN_DIMENSIONS.indexOf(dimension.name);
  return rank === -1 ? KNOWN_DIMENSIONS.length : rank;
}

/**
 * Put the dimensions in canonical run order: `wiki` before `kg`, always.
 *
 * The sequence `ingest -> compile wiki -> compile kg` is a REQUIREMENT, not an
 * observation. It used to hold only because `resolveDimensions` happens to compose
 * the dimensions in {@link KNOWN_DIMENSIONS} order, so a caller that assembled its
 * own array could invert the flow and nothing would say so. Ordering here makes the
 * guarantee the coordinator's, so no route re-decides it.
 *
 * The sort is stable, so dimensions ranking equally keep their relative order
 * instead of shuffling between runs.
 *
 * @param dimensions - Dimensions in whatever order the caller passed them.
 * @returns The same dimensions, canonically ordered.
 */
function orderCanonically(dimensions: readonly Dimension[]): Dimension[] {
  return [...dimensions].sort((left, right) => rankOf(left) - rankOf(right));
}

/**
 * Reduce one run's mutable progress to the record the report consumes.
 *
 * Order matters: a thrown error is the sharpest fact, then a committed summary, and
 * otherwise no write landed (`declined`).
 *
 * @param run - One dimension's progress.
 * @returns Its per-run record.
 */
function reportOf(run: DimensionRun): DimensionRunReport {
  const name = run.dimension.name;
  if (run.failure !== undefined) return { name, state: "failed", error: run.failure };
  if (run.committed !== null) return { name, state: "committed", summary: run.committed.summary };
  return { name, state: "declined" };
}

/**
 * Collect the per-dimension records for one run, in canonical run order.
 *
 * @param runs - Dimensions this ingest touched, already in canonical order.
 * @returns One record per dimension.
 */
function runReportsOf(runs: readonly DimensionRun[]): DimensionRunReport[] {
  return runs.map((run) => reportOf(run));
}

/**
 * Run one ingest across the supplied dimensions, atomically and in canonical order.
 *
 * @param db - Tenant-bound database handle; RLS decides which rows are visible.
 * @param stackId - Stack this ingest belongs to, bound on the transaction.
 * @param input - Source identity, title, and document.
 * @param dimensions - Dimensions to write; the coordinator orders them itself.
 * @returns What each dimension reported, plus any projection outcome.
 * @throws {IngestDimensionFailure} when any dimension fails; carries the per-run
 *   state it recorded, and the transaction rolls back as a unit.
 *
 * The coordinator takes a Stack rather than a project root because an ingest
 * belongs to a Stack: both dimensions are bound to it, and the tenant binding is
 * what makes the rows of two projects sharing one database indistinguishable to
 * each other.
 */
export async function ingestDimensions(
  db: DatabaseHandle,
  stackId: string,
  input: DimensionInput,
  dimensions: readonly Dimension[],
  options: IngestDimensionsOptions = {},
): Promise<IngestOutcome> {
  const runs: DimensionRun[] = orderCanonically(dimensions).map((dimension) => ({
    dimension,
    prepared: null,
    committed: null,
    failure: undefined,
  }));
  const now = options.now ?? (() => new Date().toISOString());

  await prepareEveryDimension(runs, input);
  await commitOrReport(db, stackId, runs, input, options.attempts, now);

  const projected = await runProjections(runs);
  return {
    summaries: summariesOf(runs),
    dimensionRuns: runReportsOf(runs),
    ...(projected.writeStatus === undefined ? {} : { writeStatus: projected.writeStatus }),
    ...(projected.artifactPath === undefined ? {} : { artifactPath: projected.artifactPath }),
  };
}
