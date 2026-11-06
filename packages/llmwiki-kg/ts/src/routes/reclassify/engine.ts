/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/engine.ts
 * @description Stage 2 of a reclassification run: decide again, with no database
 * handle and no transaction open.
 *
 * ## The batch is built from storage, and nothing else
 *
 * Each selected row contributes one candidate — reconstructed from its stored name or
 * endpoints and its ORIGINAL predicate — plus the quote and stored chunk its evidence
 * row already carries. The stack is handed to `classifyCandidates`, the same entry
 * point an ingest uses, so the questions, the interpretation, the thresholds and the
 * compatibility check cannot differ between the two paths. A reclassification is a
 * second visit to the same classifier, not a second classifier.
 *
 * ## Semantic support is passed through, not re-asked
 *
 * Support is a judgement about the SOURCE — does this text back this claim — and
 * reclassification does not change the source. Asking again would let an outage
 * overwrite a support verdict a previous run obtained, and would double the provider
 * calls for information that cannot have changed. The stored `support_state` travels
 * into the batch untouched, so the row keeps it byte for byte (S23).
 *
 * ## Failure is data, exactly as on the ingest path
 *
 * A provider problem reaches the caller as `pending` / `failed` decisions through
 * `requestDecision`, never as an exception and never as an abstention (S25). The only
 * thing that can throw here is an invariant violation — a decision whose state and
 * canonical type disagree — and that is a bug worth failing the request for.
 */

import { classifyCandidates } from "../../core/classify/batch.js";
import type { ClassificationBatch, SupportState } from "../../core/classify/types.js";
import type { TypeCatalog } from "../../core/catalog/types.js";
import { validateDecisions } from "../ingest/classify-stage.js";
import type { ClassificationRuntime } from "../ingest/classify-stage.js";
import type { ReclassifyRow } from "./types.js";

/** What stages 2 needs: the rows to re-decide, the catalog and the client. */
export interface ClassifyStoredInput {
  readonly rows: readonly ReclassifyRow[];
  readonly catalog: TypeCatalog;
  readonly runtime: ClassificationRuntime;
  /** Canonical types of already-known endpoints, passed to the compatibility check. */
  readonly endpointTypes: ReadonlyMap<string, string>;
}

/** The support state per candidate ref, taken from what storage already holds. */
function storedSupport(rows: readonly ReclassifyRow[]): Readonly<Record<string, SupportState>> {
  const support: Record<string, SupportState> = {};
  for (const row of rows) {
    if (row.stored.supportState !== null) support[row.ref] = row.stored.supportState;
  }
  return support;
}

/**
 * Decides again about every selected row, outside any transaction (S44).
 *
 * @param input - Rows, catalog and decision runtime.
 * @returns One validated decision per row, entities first.
 * @throws {DecisionInvariantError} When a decision contradicts itself.
 */
export async function classifyStored(input: ClassifyStoredInput): Promise<ClassificationBatch> {
  const batch = await classifyCandidates({
    candidates: input.rows.map((row) => row.candidate),
    catalog: input.catalog,
    client: input.runtime.client,
    config: input.runtime.config,
    evidence: Object.fromEntries(input.rows.map((row) => [row.ref, row.evidence])),
    supportStates: storedSupport(input.rows),
    endpointTypes: input.endpointTypes,
  });
  validateDecisions(batch);
  return batch;
}
