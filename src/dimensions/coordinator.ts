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
 * to the SAME database -- `wiki.pages`, `wiki.source_documents`, `stack_documents`
 * and `ingest_outbox` are four tables of one database reached through one pooled
 * client.
 *
 * Inside one transaction order is free. What the coordinator owns instead:
 *
 *   1. **The transaction.** It opens it, binds the Stack on it, and hands it to
 *      every dimension through `CommitScope`. A dimension that opens its own
 *      connection silently breaks atomicity, which is the one rule the port states.
 *   2. **The retry.** Up to {@link MAX_TX_ATTEMPTS} attempts of the SAME
 *      transaction body, reusing the prepared handles. Retrying the handles rather
 *      than the run is what keeps a retry free: `prepare` is where the provider
 *      calls live, and it does not run twice.
 *   3. **The record.** `pending` is written INSIDE the transaction, so a rollback
 *      erases it -- correct, because a rolled-back ingest left nothing to finish.
 *      A `failed` record is written AFTER the rollback, outside any transaction,
 *      because writing it inside would erase it too.
 *
 * ## What each failure does
 *
 *   - a `prepare` throws                       -> nothing committed; no record kept.
 *   - the transaction throws on attempt 1      -> rolled back, retried.
 *   - the transaction throws on both attempts  -> rolled back, `failed` recorded,
 *                                                 error rethrown. Nothing landed:
 *                                                 the source file was never
 *                                                 touched, since the projection
 *                                                 runs after a commit.
 *   - an `afterCommit` throws                  -> the transaction HAS committed;
 *                                                 rows stay, the projection reports,
 *                                                 error rethrown.
 *   - the process dies at any point            -> the transaction never committed,
 *                                                 so Postgres leaves nothing behind.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { mintIngestId, saveRecord, type OutboxDimensionEntry, type OutboxRecord } from "./outbox.js";
import type { AfterCommitEffect, CommittedWrite, Dimension, DimensionInput, PreparedWrite } from "./types.js";

/** How many times the transaction body is attempted before the ingest fails. */
const MAX_TX_ATTEMPTS = 2;

/** One dimension's progress across the whole run. */
interface DimensionRun {
  readonly dimension: Dimension;
  prepared: PreparedWrite | null;
  committed: CommittedWrite | null;
}

/** Result of a successful two-dimension ingest. */
export interface IngestOutcome {
  /** The outbox record written for this run. */
  readonly record: OutboxRecord;
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
}

/** Build a pending outbox record for the dimensions about to run. */
function buildRecord(
  ingestId: string,
  input: DimensionInput,
  runs: readonly DimensionRun[],
  status: OutboxRecord["status"],
): OutboxRecord {
  return {
    version: 1,
    ingestId,
    source: input.source,
    title: input.title,
    document: input.document,
    body: input.body,
    status,
    dimensions: runs.map((run): OutboxDimensionEntry => ({
      name: run.dimension.name,
      idempotencyKey: null,
    })),
    createdAt: new Date().toISOString(),
  };
}

/** Replace one dimension's entry in a record, preserving order. */
function withKey(
  record: OutboxRecord,
  name: string,
  idempotencyKey: string,
): OutboxRecord {
  return {
    ...record,
    dimensions: record.dimensions.map((entry) =>
      entry.name === name ? { ...entry, idempotencyKey } : entry,
    ),
  };
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
 * @param input - Source identity, title, and document.
 * @returns The committed record, ready for the success write.
 * @throws When any dimension fails; the transaction rolls back as a unit.
 */
async function commitInOneTransaction(
  db: Database,
  stackId: string,
  runs: readonly DimensionRun[],
  record: OutboxRecord,
): Promise<OutboxRecord> {
  return db.transaction(async (tx) => {
    const scope = { tx: tx as unknown };
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    // BEFORE the dimension writes: a crash mid-transaction leaves a `pending` row
    // that rolls back with everything else, so it never becomes false debt.
    await saveRecord(tx as unknown as Database, stackId, record);
    let current = record;
    for (const run of runs) {
      // `prepare` assigns before this loop, so the guard is defensive.
      if (run.prepared === null) continue;
      run.committed = await run.dimension.commit(run.prepared, scope);
      current = withKey(current, run.dimension.name, run.committed.idempotencyKey);
    }
    const committed: OutboxRecord = { ...current, status: "committed" };
    await saveRecord(tx as unknown as Database, stackId, committed);
    return committed;
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
 * @param record - Pending record to write inside the transaction.
 * @returns The committed record.
 * @throws The LAST attempt's error, after every attempt rolled back.
 */
async function attemptWithRetry(
  db: Database,
  stackId: string,
  runs: readonly DimensionRun[],
  record: OutboxRecord,
): Promise<OutboxRecord> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt += 1) {
    // A failed attempt leaves partial `committed` values behind; clearing them
    // keeps the post-mortem honest about what actually landed (nothing).
    for (const run of runs) run.committed = null;
    try {
      return await commitInOneTransaction(db, stackId, runs, record);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Record a failed ingest OUTSIDE the transaction it just rolled back.
 *
 * Must not throw: the caller is already handling the real failure, and replacing it
 * with a bookkeeping error would hide the cause. A record that cannot be written
 * costs the diagnostic, not the error.
 *
 * @param db - Pooled handle; deliberately not the rolled-back transaction.
 * @param stackId - Stack this ingest belonged to.
 * @param record - Pending record describing what was attempted.
 */
async function recordFailure(
  db: Database,
  stackId: string,
  record: OutboxRecord,
): Promise<void> {
  try {
    await saveRecord(db, stackId, { ...record, status: "failed" });
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
 * Run one ingest across the supplied dimensions, atomically.
 *
 * @param db - Tenant-bound database handle; RLS decides which records are visible.
 * @param stackId - Stack this ingest belongs to, written onto every record.
 * @param input - Source identity, title, and document.
 * @param dimensions - Dimensions to write, in commit order.
 * @throws When any dimension fails; the transaction rolls back as a unit.
 *
 * The outbox takes a Stack rather than a project root because an ingest belongs to
 * a Stack: both dimensions are bound to it, and a record scoped to a checkout would
 * let two projects sharing one database reconcile each other's interrupted runs.
 */
export async function ingestDimensions(
  db: Database,
  stackId: string,
  input: DimensionInput,
  dimensions: readonly Dimension[],
): Promise<IngestOutcome> {
  const runs: DimensionRun[] = dimensions.map((dimension) => ({
    dimension,
    prepared: null,
    committed: null,
  }));
  const ingestId = mintIngestId();
  const pending = buildRecord(ingestId, input, runs, "pending");

  try {
    for (const run of runs) {
      run.prepared = await run.dimension.prepare(input);
    }
  } catch (error) {
    // NOTHING WAS EVER WRITTEN. The `pending` record is saved inside the
    // transaction, so a `prepare` failure leaves no row to remove and no debt to
    // replay -- there is no record id to clean up because none was ever created.
    await discardPreparedWrites(runs);
    throw error;
  }

  let committedRecord: OutboxRecord;
  try {
    committedRecord = await attemptWithRetry(db, stackId, runs, pending);
  } catch (error) {
    const unresolved = await discardPreparedWrites(runs);
    await recordFailure(db, stackId, pending);
    const names = unresolved.length === 0 ? "" : ` (unresolved: ${unresolved.join(", ")})`;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`ingest failed after ${MAX_TX_ATTEMPTS} attempts: ${reason}${names}`, {
      cause: error,
    });
  }

  const projected = await runProjections(runs);
  const summaries = new Map<string, string>();
  for (const run of runs) {
    if (run.committed === null) continue;
    summaries.set(run.dimension.name, run.committed.summary);
  }
  return {
    record: committedRecord,
    summaries,
    ...(projected.writeStatus === undefined ? {} : { writeStatus: projected.writeStatus }),
    ...(projected.artifactPath === undefined ? {} : { artifactPath: projected.artifactPath }),
  };
}
