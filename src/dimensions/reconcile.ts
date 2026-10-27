/**
 * @file src/dimensions/reconcile.ts
 * @description Finishes or rolls back ingests that an earlier run left pending.
 *
 * A `pending` outbox record means a process stopped between commits. There are
 * exactly two honest resolutions, chosen by what the record proves happened:
 *
 *   - **Finish.** Every dimension still lacking a key is retried, using the
 *     document retained in the record. Each dimension's commit is idempotent
 *     under its key, so a dimension that already landed is not written twice.
 *   - **Report.** If a retry fails, the record stays pending and the caller is
 *     told which ingest needs a human. Silently dropping it would hide a
 *     half-applied ingest, which is the one outcome the outbox exists to
 *     prevent.
 *
 * Reconciliation is deliberately conservative: it never deletes a record it
 * could not resolve, and it never invents a recovery for a record it cannot
 * parse. Malformed records are surfaced, not skipped.
 */

import {
  loadRecords,
  removeRecord,
  saveRecord,
  type OutboxRecord,
} from "./outbox.js";
import type { Database } from "llmwiki-kg";
import type { Dimension, DimensionInput } from "./types.js";

/** One record the reconciler could not resolve. */
export interface UnresolvedIngest {
  readonly ingestId: string;
  readonly reason: string;
}

/** Outcome of one reconciliation pass. */
export interface ReconcileOutcome {
  /** Records that were finished and removed. */
  readonly finished: readonly string[];
  /** Records that remain pending, with the reason. */
  readonly unresolved: readonly UnresolvedIngest[];
  /** Files that exist but are not parseable records. */
  readonly unreadable: readonly string[];
  /**
   * Ingest ids whose record says both transaction attempts failed.
   *
   * Reported, never retried. With atomic ingest a rollback erases the `pending`
   * record, so a `failed` record describes an attempt that left NOTHING behind:
   * replaying it would commit work the caller was told had failed, and the caller
   * may already have fixed the cause and re-ingested.
   */
  readonly failed: readonly string[];
}

/** Rebuild the dimension input a record retained. */
function inputOf(record: OutboxRecord): DimensionInput {
  return {
    source: record.source,
    title: record.title,
    document: record.document,
    body: record.body,
  };
}

/**
 * Retry the dimensions of one record that have not recorded a key.
 *
 * Idempotency is the dimension's job: replaying a committed dimension would be
 * harmless, but skipping it is strictly cheaper, so only missing keys are run.
 */
async function finishRecord(
  db: Database,
  stackId: string,
  record: OutboxRecord,
  dimensions: readonly Dimension[],
): Promise<void> {
  const input = inputOf(record);
  let updated = record;

  for (const dimension of dimensions) {
    const entry = updated.dimensions.find((item) => item.name === dimension.name);
    if (entry === undefined || entry.idempotencyKey !== null) continue;
    const prepared = await dimension.prepare(input);
    const committed = await dimension.commit(prepared);
    updated = {
      ...updated,
      dimensions: updated.dimensions.map((item) =>
        item.name === dimension.name
          ? { ...item, idempotencyKey: committed.idempotencyKey }
          : item,
      ),
    };
    await saveRecord(db, stackId, updated);
  }

  await saveRecord(db, stackId, { ...updated, status: "committed" });
  await removeRecord(db, stackId, record.ingestId);
}

/**
 * Resolve every pending record in the outbox.
 *
 * Committed records are also removed: they describe a finished ingest, so
 * keeping them would grow the outbox without bound.
 *
 * @param db - Tenant-bound database handle; RLS decides which records are visible.
 * @param stackId - Stack whose pending ingests are being finished.
 * @param dimensions - Dimensions available to finish pending work.
 */
export async function reconcileOutbox(
  db: Database,
  stackId: string,
  dimensions: readonly Dimension[],
): Promise<ReconcileOutcome> {
  const { records, unreadable } = await loadRecords(db, stackId);
  const finished: string[] = [];
  const unresolved: UnresolvedIngest[] = [];
  const failed: string[] = [];

  for (const record of records) {
    if (record.status === "failed") {
      // KEPT, not swept: this is the only trail an operator has for an ingest that
      // left nothing behind, and it must survive until someone reads it.
      failed.push(record.ingestId);
      continue;
    }
    if (record.status === "committed") {
      await removeRecord(db, stackId, record.ingestId);
      finished.push(record.ingestId);
      continue;
    }
    try {
      await finishRecord(db, stackId, record, dimensions);
      finished.push(record.ingestId);
    } catch (error) {
      unresolved.push({
        ingestId: record.ingestId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { finished, unresolved, unreadable, failed };
}
