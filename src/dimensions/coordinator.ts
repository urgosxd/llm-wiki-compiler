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
 * Roll back every dimension that already committed, newest first.
 *
 * Returns the dimensions whose rollback FAILED, so the caller can keep the
 * outbox record instead of pretending the world is clean.
 */
async function rollbackCommitted(
  runs: readonly DimensionRun[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const run of [...runs].reverse()) {
    if (run.prepared === null) continue;
    try {
      await run.dimension.discard(run.prepared);
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
    const rollbackFailures = await rollbackCommitted(runs);
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
