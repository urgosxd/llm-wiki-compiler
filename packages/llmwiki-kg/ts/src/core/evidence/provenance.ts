/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/provenance.ts
 * @description The provenance record a candidate span becomes in `kg_evidence`.
 *
 * ## Why this is a builder and not a bare interface
 *
 * S10 asks every candidate to keep its document, chunk, quote, verifiable
 * offsets, model and pipeline version. `kg_evidence` accepts those values under
 * two constraints that are invisible in a TypeScript type: both offsets are set
 * or both are null with `char_start >= 0` and `char_end > char_start`, and
 * `evidence_kind` is limited to `textual` or `semantic`. A record that only
 * satisfies the type would fail later, inside a database transaction, far from
 * the code that produced it — so the mapping happens here, once, and an invalid
 * span is refused immediately.
 *
 * ## Absence is recorded, never dropped
 *
 * A `not_found` quote still produces a row: `evidenceText` keeps what the
 * extractor claimed and the offsets are null. Dropping the candidate instead
 * would erase the fact that the extractor cited something the source does not
 * contain, which is the single most useful signal a reviewer or an evaluation
 * set can have.
 */

import type { EvidenceAssessment } from "./assessment.js";
import { evidenceKindOf } from "./assessment.js";
import { EvidenceStageError, isLocatedQuote } from "./types.js";
import type { CandidateKind, EvidenceKind, QuoteMatchKind } from "./types.js";

/**
 * One candidate span, in the shape `kg_evidence` stores.
 *
 * Field names follow the columns so the write path needs no translation:
 * `candidate_kind`, `candidate_ref`, `document_id`, `chunk_id`, `chunk_index`,
 * `evidence_text`, `char_start`, `char_end`, `normalized_match`, `evidence_kind`,
 * `model`, `pipeline_version`, and the optional `catalog_version`.
 */
export interface EvidenceProvenance {
  /** What the evidence is about: an entity or a relationship. */
  readonly candidateKind: CandidateKind;
  /** Run-scoped candidate identifier, assigned before any UUID exists. */
  readonly candidateRef: string;
  /** `stack_documents` id of the source document. */
  readonly documentId: string;
  /** `document_chunks` id, when the chunk is already persisted. */
  readonly chunkId: string | null;
  /** Position of the chunk inside its document. */
  readonly chunkIndex: number | null;
  /** The quote exactly as the extractor produced it. */
  readonly evidenceText: string;
  /** Start offset in the chunk content, or null when the quote was not located. */
  readonly charStart: number | null;
  /** End offset (exclusive) in the chunk content, or null when not located. */
  readonly charEnd: number | null;
  /** How the quote matched, or null when it did not. */
  readonly match: QuoteMatchKind | null;
  /** `evidence_kind = 'normalized'` in the schema's boolean column terms. */
  readonly normalizedMatch: boolean;
  /** `textual` when only presence is known, `semantic` once support was judged. */
  readonly evidenceKind: EvidenceKind;
  /** Extraction model id, so the quote can be re-checked against the same producer. */
  readonly model: string | null;
  /** Pipeline version that produced the candidate. */
  readonly pipelineVersion: string | null;
  /** Catalog version in force, when the stage that ran had one. */
  readonly catalogVersion: string | null;
}

/** What the caller owns when asking for a provenance record. */
export interface EvidenceProvenanceInput {
  /** What the evidence is about: an entity or a relationship. */
  readonly candidateKind: CandidateKind;
  /** Run-scoped candidate identifier. */
  readonly candidateRef: string;
  /** `stack_documents` id of the source document. */
  readonly documentId: string;
  /** `document_chunks` id when already persisted. */
  readonly chunkId: string | null;
  /** Position of the chunk inside its document. */
  readonly chunkIndex: number | null;
  /** The quote as the extractor produced it. */
  readonly evidenceText: string;
  /** The locating result plus any support verdict. */
  readonly assessment: EvidenceAssessment;
  /** Extraction model id. */
  readonly model: string | null;
  /** Pipeline version that produced the candidate. */
  readonly pipelineVersion: string | null;
  /** Catalog version in force, or null when the stage had none. */
  readonly catalogVersion: string | null;
}

/**
 * Builds the provenance record, validating the offsets the schema will enforce.
 *
 * @param input - Caller-owned provenance fields plus the evidence assessment.
 * @returns The record, ready to become a `kg_evidence` row.
 * @throws {EvidenceStageError} when a located span would violate the stored
 *   constraint `char_start >= 0 and char_end > char_start`.
 */
export function evidenceProvenance(input: EvidenceProvenanceInput): EvidenceProvenance {
  const { assessment } = input;
  const located = isLocatedQuote(assessment.quote) ? assessment.quote.span : null;
  if (located !== null && !(located.charStart >= 0 && located.charEnd > located.charStart)) {
    throw new EvidenceStageError(
      `invalid evidence span ${located.charStart}..${located.charEnd}: ` +
        "char_start must be >= 0 and char_end must be > char_start",
    );
  }

  return {
    candidateKind: input.candidateKind,
    candidateRef: input.candidateRef,
    documentId: input.documentId,
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    evidenceText: input.evidenceText,
    charStart: located === null ? null : located.charStart,
    charEnd: located === null ? null : located.charEnd,
    match: located === null ? null : located.match,
    normalizedMatch: located !== null && located.match === "normalized",
    evidenceKind: evidenceKindOf(assessment),
    model: input.model,
    pipelineVersion: input.pipelineVersion,
    catalogVersion: input.catalogVersion,
  };
}
