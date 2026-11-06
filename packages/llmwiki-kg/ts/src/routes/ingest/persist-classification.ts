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
 * ## Evidence accumulates; it never duplicates
 *
 * The evidence write is guarded so that the same span judged again is the same
 * evidence: a retried ingest of one document cannot inflate provenance into a count
 * of attempts, while a second document that states the same claim still adds its own
 * row (S43, S45.12). The history entry, by contrast, is appended only for a decision
 * whose row was actually written — a relation folded onto another edge has no row of
 * its own, and its collision was already recorded by stage 1.
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
import { appendClassificationLog, decisionLogEntry, PENDING_PREVIOUS } from "./classification-log.js";
import type { ClassificationLogEntry, ClassificationWriteContext } from "./classification-log.js";
import type { ClassificationOutcome } from "./classify-stage.js";
import type { CandidateSpan } from "./candidates.js";

export type { ClassificationWriteContext };

/**
 * Writes one `kg_evidence` row per provenance record, once per source span.
 *
 * A span whose quote was not found still gets a row, with null offsets and
 * `normalized_match = false`: the absence is the signal, and dropping the row would
 * hide that the extractor cited text the source does not contain.
 *
 * ## Why the insert is guarded by `not exists`
 *
 * Evidence is append-only and must ACCUMULATE: a second document that states the
 * same claim records its own span, never overwriting the first (S43). But the same
 * span judged twice is the same evidence, so a retried ingest of one document must
 * not double the provenance: `kg_evidence` has no unique constraint to lean on (the
 * migration could not add one without deciding that two document-and-chunk pairs are
 * one fact), so idempotency is enforced here, on the identity of the span itself.
 *
 * What makes two rows the same span: the candidate ref, the kind of judgement, the
 * document, the chunk and the quoted text. A changed judgement about the same quote
 * is not a new evidence row — it is a decision change, and the classification log
 * is where that is recorded.
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
      select
        ${stackId}, ${provenance.candidateKind}, ${provenance.candidateRef},
        ${provenance.documentId}, ${provenance.chunkId}, ${provenance.chunkIndex},
        ${provenance.evidenceText}, ${provenance.charStart}, ${provenance.charEnd},
        ${provenance.normalizedMatch}, ${provenance.evidenceKind},
        ${provenance.model}, ${provenance.pipelineVersion}, ${provenance.catalogVersion}
      where not exists (
        select 1 from kg_evidence known
        where known.stack_id = ${stackId}
          and known.candidate_kind = ${provenance.candidateKind}
          and known.candidate_ref = ${provenance.candidateRef}
          and known.evidence_kind = ${provenance.evidenceKind}
          and known.document_id = ${provenance.documentId}
          and known.chunk_index is not distinct from ${provenance.chunkIndex}
          and known.evidence_text = ${provenance.evidenceText}
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
 * Exported because a reclassification run writes the same columns on the same row:
 * one writer for the decision columns means the two operations cannot disagree about
 * which column holds what. Nothing here touches `type`, `verified`, `properties` or
 * the row's identity, which is what lets the update land on a row other facts already
 * point at (S28).
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model for this run.
 * @param entityId - The row this decision belongs to.
 * @param decision - The validated entity decision.
 */
export async function applyEntityDecision(
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
 * Exported for the same reason as {@link applyEntityDecision}.
 *
 * @param tx - The write transaction.
 * @param context - Stack, versions and model for this run.
 * @param edge - The resolved endpoints, and the row's identity key.
 * @param decision - The validated relation decision.
 * @returns `true` when a row matched. `false` means the assertion has no row of its
 *   own — the `unique_edge_per_stack` collision stage 1 already recorded — so no
 *   history entry may be written claiming it was decided.
 */
export async function applyRelationDecision(
  tx: Database,
  context: ClassificationWriteContext,
  edge: { readonly fromId: string; readonly toId: string; readonly identityKey: string },
  decision: RelationClassificationDecision,
): Promise<boolean> {
  const readout = decision.readout;
  const updated = await tx.execute<{ id: string }>(sql`
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
    returning id
  `);
  return updated.length > 0;
}

/**
 * Stage 7: persists evidence, decisions and history in the caller's transaction.
 *
 * The history entry for each decision is appended only when the row it describes was
 * actually written. A relation whose assertion has no row of its own — the folded
 * `unique_edge_per_stack` collision, already recorded by stage 1 — must not leave a
 * log entry claiming a decision that no row holds.
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
  const history: ClassificationLogEntry[] = [];
  for (const decision of outcome.entityDecisions) {
    const entityId = entityIds.get(decision.name.toLowerCase());
    if (entityId === undefined) continue;
    await applyEntityDecision(tx, context, entityId, decision);
    history.push(decisionLogEntry(decision, PENDING_PREVIOUS));
  }
  for (const decision of outcome.relationDecisions) {
    const fromId = entityIds.get(decision.fromName.toLowerCase());
    const toId = entityIds.get(decision.toName.toLowerCase());
    if (fromId === undefined || toId === undefined) continue;
    const matched = await applyRelationDecision(
      tx,
      context,
      { fromId, toId, identityKey: decision.identityKey },
      decision,
    );
    if (!matched) continue;
    history.push(decisionLogEntry(decision, PENDING_PREVIOUS));
  }
  await appendClassificationLog(tx, context, history);
}
