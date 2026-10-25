/**
 * @file src/dimensions/coordinator.ts
 * @description Runs one ingest across every enabled dimension under the
 * two-phase outbox, so a failure never leaves one dimension silently ahead of
 * another without a durable record of what happened.
 *
 * ## The ordering rule
 *
 * Dimensions commit in a fixed order: `wiki` first, then `kg`. The wiki write is
 * the cheap, local, revertible half; the graph write is the expensive, remote
 * half. Committing wiki first means a graph failure can be answered by rolling
 * the wiki back, which is a local, reliable operation. Committing the graph
 * first would leave the only recovery path a remote delete, which is exactly the
 * fragile direction.
 *
 * ## What each failure does
 *
 *   - a `prepare` throws                      -> nothing committed; outbox removed.
 *   - a `commit` throws, earlier ones committed -> every committed dimension is
 *     discarded (rolled back), outbox removed, error rethrown. The ingest fails
 *     as a unit, which is what "with rollback" means here.
 *   - a `discard` throws                      -> the outbox record is KEPT with
 *     status `pending`, so the reconciler can finish the rollback instead of
 *     leaving an unrecorded half state.
 *   - the process dies at any point           -> the `pending` record on disk is
 *     the recovery trail; `reconcile` replays it.
 *
 * The outbox record is persisted **before** the first commit, which is what
 * makes the last case recoverable at all.
 */

import { mintIngestId, removeRecord, saveRecord, type OutboxDimensionEntry, type OutboxRecord } from "./outbox.js";
import type { CommittedWrite, Dimension, DimensionInput, PreparedWrite } from "./types.js";

/** One dimension's progress during a run. */
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
): OutboxRecord {
  return {
    version: 1,
    ingestId,
    source: input.source,
    title: input.title,
    document: input.document,
    body: input.body,
    status: "pending",
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
 * Undo what can still be undone, newest first.
 *
 * Returns the dimensions whose work could NOT be undone, so the caller keeps the
 * outbox record instead of pretending the world is clean.
 *
 * ## Two questions, and they are not the same one
 *
 * which dimensions to ASK, and which answers to BELIEVE. This function used to
 * answer both with one condition, and the name it kept -- `rollbackCommitted` --
 * described only the second.
 *
 * **Who is asked: everything that PREPARED.** `discard` undoes a prepared write,
 * and that is what `Dimension.discard` is documented to do. A dimension that
 * prepared may have left something behind on the way (`wiki` writes its source
 * markdown inside `commit`, but a future dimension could allocate in `prepare`),
 * so it is always given the chance. A dimension that never prepared has nothing
 * to undo and is skipped.
 *
 * **Whose silence is believed: only the uncommitted ones.** A quiet return means
 * "I did what I could", not "the write is gone". A database-backed dimension
 * commits inside its own transaction, so there is nothing left to abandon and its
 * `discard` is a no-op by design -- it returned quietly while the row STAYED. This
 * used to count as a clean rollback, so the caller deleted the only record of a
 * half-applied ingest: silent data, silently unrecoverable.
 *
 * So a dimension that COMMITTED and cannot prove it undid anything is a failure:
 * the record stays `pending` and `reconcileOutbox` finishes it by replaying the
 * idempotent commit. A dimension that never committed is trusted to have cleaned
 * up after itself, because there was never anything visible.
 *
 * The two conditions were split rather than merged into `committed !== null`
 * because merging them would skip `discard` for a prepared-but-uncommitted
 * dimension, silently discarding the one compensation the port does promise.
 *
 * @param runs - Every dimension this ingest touched.
 * @returns Names of dimensions whose committed work may still be visible.
 */
async function undoPreparedWrites(
  runs: readonly DimensionRun[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const run of [...runs].reverse()) {
    if (run.prepared === null) continue;
    const isVisibleToReaders = run.committed !== null;
    try {
      await run.dimension.discard(run.prepared);
      // A committed write that reported success without throwing is only
      // trustworthy if the dimension actually reverts. Nothing in the port
      // promises that, so it is recorded as unresolved rather than assumed.
      if (isVisibleToReaders) failures.push(run.dimension.name);
    } catch {
      failures.push(run.dimension.name);
    }
  }
  return failures;
}

/**
 * Run one ingest across the supplied dimensions.
 *
 * @param root - Project root, where the outbox lives.
 * @param input - Source identity, title, and document.
 * @param dimensions - Dimensions to write, in commit order.
 * @throws When any dimension fails; committed dimensions are rolled back first.
 */
export async function ingestDimensions(
  root: string,
  input: DimensionInput,
  dimensions: readonly Dimension[],
): Promise<IngestOutcome> {
  const runs: DimensionRun[] = dimensions.map((dimension) => ({
    dimension,
    prepared: null,
    committed: null,
  }));
  const ingestId = mintIngestId();
  let record = buildRecord(ingestId, input, runs);

  try {
    await saveRecord(root, record);
    for (const run of runs) {
      run.prepared = await run.dimension.prepare(input);
    }
    for (const run of runs) {
      // `prepare` always assigns before this loop, so the guard is defensive.
      if (run.prepared === null) continue;
      run.committed = await run.dimension.commit(run.prepared);
      record = withKey(record, run.dimension.name, run.committed.idempotencyKey);
      await saveRecord(root, record);
    }
  } catch (error) {
    const rollbackFailures = await undoPreparedWrites(runs);
    // Keep the record ONLY when the rollback is incomplete: it is then the
    // trail the reconciler needs. A clean rollback leaves nothing to recover.
    if (rollbackFailures.length === 0) {
      await removeRecord(root, ingestId);
    } else {
      await saveRecord(root, { ...record, status: "pending" });
    }
    throw error;
  }

  const committed: OutboxRecord = { ...record, status: "committed" };
  await saveRecord(root, committed);
  const summaries = new Map<string, string>();
  let writeStatus: IngestOutcome["writeStatus"];
  let artifactPath: string | undefined;
  for (const run of runs) {
    if (run.committed === null) continue;
    summaries.set(run.dimension.name, run.committed.summary);
    // First dimension to report wins; today only `wiki` writes files.
    writeStatus ??= run.committed.writeStatus;
    artifactPath ??= run.committed.artifactPath;
  }
  return {
    record: committed,
    summaries,
    ...(writeStatus === undefined ? {} : { writeStatus }),
    ...(artifactPath === undefined ? {} : { artifactPath }),
  };
}
