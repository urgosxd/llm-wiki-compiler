/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/run.ts
 * @description The reclassification operation itself: three steps, two short
 * transactions, and one provider stage between them.
 *
 * ## The shape, and why it is this shape
 *
 * 1. READ — the rows whose decision is stale, the catalog they will be judged against,
 *    and the located quote each of them already has. No provider call, nothing written.
 * 2. DECIDE — `classifyStored`, with NO transaction open and no database handle. This
 *    is the whole point of the split: a classifier call can take seconds, and holding a
 *    transaction across it is what S44 forbids.
 * 3. WRITE — the decisions, their history and the refusals, in one transaction that
 *    opens after the last answer arrived.
 *
 * A caller supplies the {@link TransactionRunner}, exactly as the ingest pipeline
 * does, so the same handler runs under the pool's runner in production and under a
 * fixture pool in a test without a second copy of this order.
 *
 * ## What the report is for
 *
 * A sweep touches many rows, and the interesting outcomes are mutually exclusive per
 * row. The counts are what makes a run auditable at a glance: how many rows were
 * selected, how many actually changed, how many converged silently, how many were
 * refused because a human had verified them, and how many were preserved because the
 * classifier could not answer. `truncated` says whether one run was allowed to take
 * everything that matched — a bounded sweep must be legible as bounded (S9).
 */

import { CLASSIFIER_VERSION } from "../ingest/classify-stage.js";
import type { ClassificationRuntime } from "../ingest/classify-stage.js";
import type { TransactionRunner } from "../ingest/pipeline.js";
import { classifyStored } from "./engine.js";
import { planReclassification } from "./plan.js";
import { persistReclassification } from "./persist.js";
import type { PlannedDecision } from "./persist.js";
import { selectForReclassification } from "./select.js";
import type { ReclassificationReport, ReclassifyRow } from "./types.js";

/** What one reclassification request asks for. */
export interface ReclassifyRequest {
  readonly stackId: string;
  /** Rows per kind one run may take. */
  readonly limit: number;
}

/**
 * Pairs each selected row with the decision made about it.
 *
 * Looked up by candidate ref rather than by position: the batch returns entities then
 * relations, which is the same order the selection uses, but a positional assumption
 * would break silently the day either side reorders.
 *
 * @param rows - The classifiable rows, in selection order.
 * @param batch - What the classifier decided.
 * @returns One planned decision per row.
 * @throws {Error} When the batch answered about a candidate the selection did not send.
 */
function planAll(
  rows: readonly ReclassifyRow[],
  batch: Awaited<ReturnType<typeof classifyStored>>,
): readonly PlannedDecision[] {
  const byRef = new Map(batch.decisions.map((decision) => [decision.ref, decision]));
  return rows.map((row) => {
    const decision = byRef.get(row.ref);
    if (decision === undefined) {
      throw new Error(`the classifier returned no decision for ${row.ref}`);
    }
    const action = planReclassification(row.stored, decision, {
      classifierVersion: CLASSIFIER_VERSION,
    });
    return { row, decision, action };
  });
}

/**
 * Runs one reclassification pass over one Stack.
 *
 * @param run - How this deployment opens a short transaction.
 * @param runtime - The decision client and its configuration.
 * @param request - The Stack and the per-run bound.
 * @returns The report, or `undefined` when the Stack does not exist.
 */
export async function reclassifyStack(
  run: TransactionRunner,
  runtime: ClassificationRuntime,
  request: ReclassifyRequest,
): Promise<ReclassificationReport | undefined> {
  const selection = await run((tx) =>
    selectForReclassification(tx, request.stackId, {
      classifierVersion: CLASSIFIER_VERSION,
      limit: request.limit,
    }),
  );
  if (selection === undefined) return undefined;
  const batch = await classifyStored({
    rows: selection.classifiable,
    catalog: selection.catalog,
    runtime,
    endpointTypes: selection.endpointTypes,
  });
  const planned = planAll(selection.classifiable, batch);
  const counts = await run((tx) =>
    persistReclassification(
      tx,
      {
        stackId: request.stackId,
        catalogVersion: selection.catalogVersion,
        classifierVersion: CLASSIFIER_VERSION,
        jevModel: runtime.config.model,
      },
      planned,
      selection.refusedVerified,
    ),
  );
  return {
    stack_id: request.stackId,
    catalog_version: selection.catalogVersion,
    classifier_version: CLASSIFIER_VERSION,
    jev_model: runtime.config.model,
    selected: selection.selected,
    applied: counts.applied,
    changed: counts.changed,
    versions_refreshed: counts.versionsRefreshed,
    unchanged: counts.unchanged,
    refused_verified: selection.refusedVerified.length,
    preserved_after_failure: counts.preservedAfterFailure,
    skipped_no_evidence: selection.skippedNoEvidence,
    truncated: selection.truncated,
  };
}
