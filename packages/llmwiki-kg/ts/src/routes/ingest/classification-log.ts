/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classification-log.ts
 * @description The append-only history of classification decisions, and the one
 * writer both the ingest pipeline and a reclassification run use.
 *
 * ## Why this lives apart from the persistence stage
 *
 * Two operations append to `kg_classification_log`: an ingest, which classifies a
 * candidate for the first time, and a reclassification pass, which decides again
 * about a row that already has an answer. They differ in exactly one respect — what
 * the PREVIOUS value is — and that difference is the whole point of the table: a
 * stored decision that changes with no trace is indistinguishable from corruption
 * (S43).
 *
 * So the entry carries its own previous state instead of the writer assuming one.
 * The ingest path passes the `pending` state stage 1 wrote; a reclassification run
 * passes the state and canonical type it actually found, and the resulting row can
 * then be read as a real transition.
 *
 * ## A collision is an entry too
 *
 * `unique_edge_per_stack` is `(stack_id, from_entity_id, to_entity_id, type)` and
 * `type` carries the FOLDED label, so two spellings of one verb between the same
 * endpoints cannot both become rows. The first predicate survives (the upsert never
 * touches `predicate`) and the second assertion is absorbed — a real decision about
 * which fact the graph keeps, recorded here with `relation_collision:<survivor>`
 * rather than dropped in silence (S43).
 *
 * ## Nothing here invents a state
 *
 * `new_state` is written exactly as the decision reported it, and every entry names
 * the catalog version, the classifier version and the vendor readout that produced
 * it. The table's CHECK constraints accept only the five states, so a typo surfaces
 * as a refused write rather than as a sixth meaning nobody defined.
 */

import { sql } from "drizzle-orm";

import type { CandidateDecision } from "../../core/classify/types.js";
import type { JevChoiceReadout } from "../../core/jev/types.js";
import type {
  CandidateKind,
  ClassificationState,
} from "../../schema-open-classification.js";
import type { Database } from "../../db.js";

/** What every write of one run shares. */
export interface ClassificationWriteContext {
  readonly stackId: string;
  /** The catalog version the decisions were made under. */
  readonly catalogVersion: string;
  /** Our label for the stage that produced them. */
  readonly classifierVersion: string;
  /** The vendor model id the requests asked for. */
  readonly jevModel: string;
}

/** One appended history row. */
export interface ClassificationLogEntry {
  readonly candidateKind: CandidateKind;
  readonly candidateRef: string;
  /** The state found before this run; `null` when the row never had a decision. */
  readonly previousState: ClassificationState | null;
  /** The state the row holds after this run. */
  readonly newState: ClassificationState;
  readonly previousCanonicalType: string | null;
  readonly newCanonicalType: string | null;
  /** The vendor's raw answer, absent when nobody answered. */
  readonly readout: JevChoiceReadout | null;
  readonly catalogVersion: string | null;
  readonly classifierVersion: string | null;
  /** Why the decision is what it is; `null` for a positive classification. */
  readonly reason: string | null;
}

/** The previous value of one row, as a writer observed it. */
export interface PreviousDecision {
  readonly state: ClassificationState | null;
  readonly canonicalType: string | null;
}

/** What stage 1 wrote before any classifier was asked: the ingest's previous value. */
export const PENDING_PREVIOUS: PreviousDecision = Object.freeze({
  state: "pending" as ClassificationState,
  canonicalType: null,
});

/**
 * Builds the history entry for one decision.
 *
 * @param decision - The validated decision.
 * @param previous - What the row held before this run.
 * @returns The entry to append.
 */
export function decisionLogEntry(
  decision: CandidateDecision,
  previous: PreviousDecision,
): ClassificationLogEntry {
  return {
    candidateKind: decision.kind,
    candidateRef: decision.ref,
    previousState: previous.state,
    newState: decision.classificationState,
    previousCanonicalType: previous.canonicalType,
    newCanonicalType: decision.canonicalType,
    readout: decision.readout,
    catalogVersion: decision.catalogVersion,
    classifierVersion: null,
    reason: decision.reason,
  };
}

/**
 * Appends every entry in the caller's transaction.
 *
 * A single loop of single-row inserts, in the caller's order: the history of one
 * run reads in candidate order, entities before relations, which is what makes the
 * table usable without a sequence column.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model this run shares.
 * @param entries - The entries to append, in order.
 */
export async function appendClassificationLog(
  tx: Database,
  context: ClassificationWriteContext,
  entries: readonly ClassificationLogEntry[],
): Promise<void> {
  for (const entry of entries) {
    const readout = entry.readout;
    await tx.execute(sql`
      insert into kg_classification_log (
        stack_id, candidate_kind, candidate_ref, previous_state, new_state,
        previous_canonical_type, new_canonical_type,
        jev_choice, jev_confidence, jev_top_probability, jev_model,
        catalog_version, classifier_version, reason
      )
      values (
        ${context.stackId}, ${entry.candidateKind}, ${entry.candidateRef},
        ${entry.previousState}, ${entry.newState},
        ${entry.previousCanonicalType}, ${entry.newCanonicalType},
        ${readout?.choice ?? null}, ${readout?.confidence ?? null},
        ${readout?.topProbability ?? null}, ${readout?.model ?? context.jevModel},
        ${entry.catalogVersion ?? context.catalogVersion},
        ${entry.classifierVersion ?? context.classifierVersion},
        ${entry.reason}
      )
    `);
  }
}
