/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/persist-classification.ts
 * @description Stage 7 of the ingest pipeline: persist the evidence, the decisions
 * and the history of those decisions.
 *
 * ## What lands here, and what deliberately does not
 *
 * Three writes, all inside ONE short transaction that is opened after every
 * external call has finished (S44):
 *
 * - `kg_evidence`: one row per candidate span, carrying the quote, the offsets into
 *   the stored chunk, the extraction model and the versions in force (S10);
 * - the classification columns on the entity and relationship rows themselves, so a
 *   reader gets the state without joining anything;
 * - `kg_classification_log`: one append-only row per decision, because a stored
 *   decision that changes with no trace is indistinguishable from corruption (S43).
 *
 * The row's PROJECTION label (`type`) is never rewritten here. It keeps the meaning
 * the export and the pages already give it; the catalog decision lives in
 * `canonical_type`, which is set only when the state is `classified`. That is also
 * why an update can never violate `unique_edge_per_stack`.
 *
 * `source.verified` is never written. That column means a human reviewed the fact
 * (AKS semantics, S39/S4), and nothing in a classification pipeline is a human.
 *
 * ## `support_state` comes from the answered question, and is NULL when unanswered
 *
 * The semantic-support question S12 separates from textual presence is asked by
 * `support-stage.ts` before classification, and its verdict travels here on each
 * decision. The column is written as received: `supported` / `unsupported` /
 * `uncertain` when the classifier answered, and NULL when it did not — an unlocated
 * quote and a provider outage both leave the question unanswered, and neither is
 * stored as if it were a judgement about the source.
 */

import { sql } from "drizzle-orm";

import { bindCallerStack } from "../../core/stack_resolver.js";
import type {
  EntityClassificationDecision,
  RelationClassificationDecision,
} from "../../core/classify/types.js";
import { hasTextualEvidence, withSupport } from "../../core/evidence/assessment.js";
import type { SemanticSupport } from "../../core/evidence/assessment.js";
import { evidenceProvenance } from "../../core/evidence/provenance.js";
import type { EvidenceProvenance } from "../../core/evidence/provenance.js";
import type { Database } from "../../db.js";
import type { ClassificationOutcome } from "./classify-stage.js";
import type { CandidateSpan } from "./candidates.js";

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

/**
 * Writes one `kg_evidence` row per provenance record.
 *
 * A span whose quote was not found still gets a row, with null offsets and
 * `normalized_match = false`: the absence is the signal, and dropping the row would
 * hide that the extractor cited text the source does not contain.
 *
 * @param tx - The write transaction.
 * @param stackId - Stack the candidates belong to.
 * @param records - The provenance records to write, textual ones first.
 */
async function writeEvidenceRows(
  tx: Database,
  stackId: string,
  records: readonly EvidenceProvenance[],
): Promise<void> {
  for (const provenance of records) {
    await tx.execute(sql`
      insert into kg_evidence (
        stack_id, candidate_kind, candidate_ref, document_id, chunk_id, chunk_index,
        evidence_text, char_start, char_end, normalized_match, evidence_kind,
        model, pipeline_version, catalog_version
      )
      values (
        ${stackId}, ${provenance.candidateKind}, ${provenance.candidateRef},
        ${provenance.documentId}, ${provenance.chunkId}, ${provenance.chunkIndex},
        ${provenance.evidenceText}, ${provenance.charStart}, ${provenance.charEnd},
        ${provenance.normalizedMatch}, ${provenance.evidenceKind},
        ${provenance.model}, ${provenance.pipelineVersion}, ${provenance.catalogVersion}
      )
    `);
  }
}

/**
 * The SEMANTIC evidence record for one span: the same quote, judged.
 *
 * The textual record answers "the source contains these words"; this one answers
 * "and here is what was decided about their meaning" (S12). Both are written, never
 * one instead of the other, and they share the candidate ref so a reader can pair
 * them. `withSupport` is what makes the pairing safe: it refuses a support verdict
 * for a quote that was never located, so a fabricated judgement cannot reach storage
 * even if a caller asks for one.
 *
 * @param span - The span the judgement was made about.
 * @param support - The classifier's semantic judgement.
 * @returns The record, with `evidence_kind = 'semantic'`.
 */
function semanticProvenance(span: CandidateSpan, support: SemanticSupport): EvidenceProvenance {
  const base = span.provenance;
  return evidenceProvenance({
    candidateKind: base.candidateKind,
    candidateRef: base.candidateRef,
    documentId: base.documentId,
    chunkId: base.chunkId,
    chunkIndex: base.chunkIndex,
    evidenceText: base.evidenceText,
    assessment: withSupport(span.assessment, support),
    model: base.model,
    pipelineVersion: base.pipelineVersion,
    catalogVersion: base.catalogVersion,
  });
}

/**
 * Every evidence record one run writes: one textual row per span, then one semantic
 * row per span whose support question was actually answered.
 *
 * An unanswered question — unlocated quote, provider outage — produces no semantic
 * row, because there is no judgement to record. That absence is the difference
 * between "nobody asked" and "the classifier said no", and it is the reason this
 * list is assembled from the judgements rather than from the spans.
 *
 * @param spans - Stage 2's output.
 * @param outcome - Stages 4-6's output, carrying the support pass.
 * @returns The records, textual first so the order is deterministic.
 */
function evidenceRecords(
  spans: readonly CandidateSpan[],
  outcome: ClassificationOutcome,
): readonly EvidenceProvenance[] {
  const textual = spans.map((span) => span.provenance);
  const semantic: EvidenceProvenance[] = [];
  for (const span of spans) {
    const support = outcome.support.get(span.candidate.ref);
    if (support === undefined || !hasTextualEvidence(span.assessment)) continue;
    semantic.push(semanticProvenance(span, support));
  }
  return [...textual, ...semantic];
}

/**
 * Updates one entity row with its decision.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model for this run.
 * @param entityId - The row this decision belongs to.
 * @param decision - The validated entity decision.
 */
async function applyEntityDecision(
  tx: Database,
  context: ClassificationWriteContext,
  entityId: string,
  decision: EntityClassificationDecision,
): Promise<void> {
  const readout = decision.readout;
  await tx.execute(sql`
    update ontology_entities
    set classification_state = ${decision.classificationState},
        canonical_type = ${decision.canonicalType},
        support_state = ${decision.supportState},
        jev_choice = ${readout?.choice ?? null},
        jev_confidence = ${readout?.confidence ?? null},
        jev_top_probability = ${readout?.topProbability ?? null},
        jev_model = ${readout?.model ?? context.jevModel},
        catalog_version = ${decision.catalogVersion},
        classifier_version = ${context.classifierVersion},
        jev_classified_at = now(),
        classification_updated_at = now()
    where id = ${entityId} and stack_id = ${context.stackId}
  `);
}

/**
 * Updates one relationship row with its decision, addressed by its identity key.
 *
 * The key is the predicate-derived one the row was written with (S33), so two
 * distinct free predicates between the same endpoints stay two rows and a later
 * reclassification finds the same one.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model for this run.
 * @param edge - The resolved endpoints, and the row's identity key.
 * @param decision - The validated relation decision.
 */
async function applyRelationDecision(
  tx: Database,
  context: ClassificationWriteContext,
  edge: { readonly fromId: string; readonly toId: string; readonly identityKey: string },
  decision: RelationClassificationDecision,
): Promise<void> {
  const readout = decision.readout;
  await tx.execute(sql`
    update ontology_relationships
    set classification_state = ${decision.classificationState},
        canonical_type = ${decision.canonicalType},
        support_state = ${decision.supportState},
        compatibility = ${decision.compatibility},
        jev_choice = ${readout?.choice ?? null},
        jev_confidence = ${readout?.confidence ?? null},
        jev_top_probability = ${readout?.topProbability ?? null},
        jev_model = ${readout?.model ?? context.jevModel},
        catalog_version = ${decision.catalogVersion},
        classifier_version = ${context.classifierVersion},
        jev_classified_at = now(),
        classification_updated_at = now()
    where stack_id = ${context.stackId}
      and from_entity_id = ${edge.fromId}
      and to_entity_id = ${edge.toId}
      and identity_key = ${edge.identityKey}
  `);
}

/**
 * Appends one history row per decision.
 *
 * `previous_state` is `pending` because that is what stage 1 wrote for every
 * candidate: the row existed before it was classified, which is what makes an
 * interrupted classification recoverable instead of invisible.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model for this run.
 * @param decisions - Every decision the run made, entities first.
 */
async function writeDecisionLog(
  tx: Database,
  context: ClassificationWriteContext,
  decisions: ClassificationOutcome,
): Promise<void> {
  for (const decision of [...decisions.entityDecisions, ...decisions.relationDecisions]) {
    const readout = decision.readout;
    await tx.execute(sql`
      insert into kg_classification_log (
        stack_id, candidate_kind, candidate_ref, previous_state, new_state,
        previous_canonical_type, new_canonical_type,
        jev_choice, jev_confidence, jev_top_probability, jev_model,
        catalog_version, classifier_version, reason
      )
      values (
        ${context.stackId}, ${decision.kind}, ${decision.ref}, ${"pending"},
        ${decision.classificationState}, ${null}, ${decision.canonicalType},
        ${readout?.choice ?? null}, ${readout?.confidence ?? null},
        ${readout?.topProbability ?? null}, ${readout?.model ?? context.jevModel},
        ${decision.catalogVersion}, ${context.classifierVersion}, ${decision.reason}
      )
    `);
  }
}

/**
 * Stage 7: persists evidence, decisions and history in the caller's transaction.
 *
 * @param tx - A SHORT write transaction, opened after every external call finished.
 * @param context - Stack, versions and model for this run.
 * @param entityIds - Folded entity name → entity row id, from stage 1.
 * @param spans - Stage 2's output, written as evidence rows.
 * @param outcome - Stages 4-6's validated decisions, or `undefined` when
 *   classification is not configured (the rows then keep their `pending` state).
 */
export async function persistClassification(
  tx: Database,
  context: ClassificationWriteContext,
  entityIds: ReadonlyMap<string, string>,
  spans: readonly CandidateSpan[],
  outcome: ClassificationOutcome | undefined,
): Promise<void> {
  // The tenant is bound per transaction: stage 1's binding left with stage 1.
  await bindCallerStack(tx, context.stackId, null);
  await writeEvidenceRows(
    tx,
    context.stackId,
    outcome === undefined ? spans.map((span) => span.provenance) : evidenceRecords(spans, outcome),
  );
  if (outcome === undefined) return;
  for (const decision of outcome.entityDecisions) {
    const entityId = entityIds.get(decision.name.toLowerCase());
    if (entityId === undefined) continue;
    await applyEntityDecision(tx, context, entityId, decision);
  }
  for (const decision of outcome.relationDecisions) {
    const fromId = entityIds.get(decision.fromName.toLowerCase());
    const toId = entityIds.get(decision.toName.toLowerCase());
    if (fromId === undefined || toId === undefined) continue;
    await applyRelationDecision(
      tx,
      context,
      { fromId, toId, identityKey: decision.identityKey },
      decision,
    );
  }
  await writeDecisionLog(tx, context, outcome);
}
