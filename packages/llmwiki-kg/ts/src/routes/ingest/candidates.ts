/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/candidates.ts
 * @description Stages 2 and 3 of the ingest pipeline: evidence, then identity.
 *
 * ## From a folded extraction result to one span per candidate
 *
 * The extraction stage hands back an `ExtractionResult` — entities and edges folded
 * across chunks — and everything later in the pipeline speaks about CANDIDATES: a
 * stable run-scoped `ref`, the text the extractor read, and a verifiable span in the
 * stored chunk. This module is that translation, and it is deliberately pure: it
 * reads its inputs, never queries, never writes, and holds no state between calls,
 * so two ingests can run through it concurrently without seeing each other.
 *
 * ## The quote is the extractor's own wording, never a summary
 *
 * The KG tool asks for names and predicates, not for a quote, so the text a
 * candidate is checked against is exactly what the extractor produced for it: the
 * entity's name, or the relation's predicate. That is a weaker claim than an
 * extractor that returned a sentence, and it is stated here rather than papered
 * over: `locateQuote` finds it verbatim or after the controlled folds, and a name
 * that does not appear in the stored chunk is recorded as `not_found` with null
 * offsets instead of being dropped (S10, S11).
 *
 * ## The chunk is the one the extractor read, not a search across the document
 *
 * `ExtractedEntity.sourceChunkIndices` records which chunks mentioned the
 * candidate, so the FIRST of them is used. Searching every chunk of the document
 * would silently pick a different chunk when chunks overlap
 * (`DEFAULT_CHUNK_OVERLAP`), and the recorded `chunk_index` would then name a chunk
 * the model never saw. The offsets are into `document_chunks.content` for the same
 * reason: that is the string the extractor was given.
 *
 * ## Identity is resolved here, and its key becomes the candidate ref
 *
 * A `ref` embeds the resolved identity key, so the same mention re-ingested
 * produces the same ref — which is what makes evidence rows and classification-log
 * rows findable across runs instead of accumulating under fresh ids (S43). The ref
 * is passed VERBATIM into `kg_evidence.candidate_ref`; nothing downstream re-derives
 * it.
 */

import { normalizeCatalogName } from "../../core/catalog/names.js";
import type {
  EntityCandidate,
  RelationCandidate,
} from "../../core/candidates/types.js";
import type { CandidateEvidence } from "../../core/classify/types.js";
import { relationIdentityKey } from "../../core/classify/identity.js";
import { assessQuote } from "../../core/evidence/assessment.js";
import { locateQuote } from "../../core/evidence/locate.js";
import { evidenceProvenance, type EvidenceProvenance } from "../../core/evidence/provenance.js";
import type { ChunkResult, ExtractionResult } from "../../core/extraction-types.js";
import { deriveIdentityKey } from "../../core/identity/key.js";

/** One candidate, the span it was read from, and the chunk those offsets index. */
export interface CandidateSpan {
  /** The candidate, carrying the `ref` every later stage and every row uses. */
  readonly candidate: EntityCandidate | RelationCandidate;
  /** The `kg_evidence` shape for this span: quote, offsets, model, versions. */
  readonly provenance: EvidenceProvenance;
  /** The STORED chunk content the offsets are valid against. */
  readonly context: string;
}

/** Everything one document's candidates are built from. */
export interface CandidateBuildInput {
  /** `stack_documents` id of the document being ingested. */
  readonly documentId: string;
  /** The folded extraction result. */
  readonly extraction: ExtractionResult;
  /** The chunks exactly as `document_chunks` holds them. */
  readonly chunks: readonly ChunkResult[];
  /** Resolved identity key per folded entity name (stage 3). */
  readonly identityKeys: ReadonlyMap<string, string>;
  /** The catalog version in force, stored with every evidence row. */
  readonly catalogVersion: string;
}

/** The folded name used to look an entity up in the identity map. */
function folded(name: string): string {
  return normalizeCatalogName(name);
}

/** The run-scoped ref of one entity candidate: its identity, inside this document. */
export function entityRef(documentId: string, identityKey: string): string {
  return `entity:${documentId}:${identityKey}`;
}

/** The run-scoped ref of one relation candidate: endpoints and original predicate. */
export function relationRef(
  documentId: string,
  fromName: string,
  predicate: string,
  toName: string,
): string {
  const parts = [folded(fromName), folded(predicate), folded(toName)];
  return `relationship:${documentId}:${parts.join("|")}`;
}

/** The identity key a relation's row must carry, derived from its original predicate. */
export function relationKey(predicate: string): string {
  return relationIdentityKey(predicate);
}

/**
 * The chunk a candidate was read from.
 *
 * @param chunks - The document's stored chunks, in order.
 * @param indices - The chunk indices the extraction recorded for the candidate.
 * @returns The first recorded chunk that exists, or the document's first chunk.
 */
function chunkOf(
  chunks: readonly ChunkResult[],
  indices: readonly number[],
): ChunkResult | undefined {
  for (const index of indices) {
    const found = chunks.find((chunk) => chunk.chunkIndex === index);
    if (found !== undefined) return found;
  }
  return chunks[0];
}

/** The provenance constants one document's spans share. */
interface DocumentProvenance {
  readonly documentId: string;
  readonly catalogVersion: string;
  readonly pipeline: string;
  readonly model: string;
}

/** What the provenance builder needs besides the document constants. */
interface SpanFields {
  readonly kind: "entity" | "relationship";
  readonly ref: string;
  readonly chunk: ChunkResult;
  readonly quote: string;
}

/**
 * Records one span in the `kg_evidence` shape.
 *
 * A quote absent from the chunk still produces a record, with null offsets:
 * dropping it would erase the fact that the extractor cited text the source does
 * not contain, which is the most useful signal a reviewer or an evaluation set can
 * get (S10, S11).
 *
 * @param document - The constants every span of this document shares.
 * @param span - The candidate kind, ref, chunk and quote.
 * @returns The validated provenance record.
 */
function provenanceFor(document: DocumentProvenance, span: SpanFields): EvidenceProvenance {
  return evidenceProvenance({
    candidateKind: span.kind,
    candidateRef: span.ref,
    documentId: document.documentId,
    // The chunk row id is not known here (chunks are upserted without
    // `returning`), and `chunk_index` plus the document identifies the text.
    chunkId: null,
    chunkIndex: span.chunk.chunkIndex,
    evidenceText: span.quote,
    assessment: assessQuote(locateQuote(span.quote, span.chunk.content)),
    model: document.model,
    pipelineVersion: document.pipeline,
    catalogVersion: document.catalogVersion,
  });
}

/**
 * One entity's span, keyed by the identity this ingest resolved for it.
 *
 * @param document - The constants every span of this document shares.
 * @param entity - The folded entity, with its proposed type and chunk indices.
 * @param chunks - The document's stored chunks.
 * @param identityKeys - Resolved key per folded name; absent falls back to the name key.
 * @returns The span, or `undefined` when the document produced no chunk at all.
 */
function entitySpan(
  document: DocumentProvenance,
  entity: ExtractionResult["entities"][number],
  chunks: readonly ChunkResult[],
  identityKeys: ReadonlyMap<string, string>,
): CandidateSpan | undefined {
  const chunk = chunkOf(chunks, entity.sourceChunkIndices);
  if (chunk === undefined) return undefined;
  const identityKey =
    identityKeys.get(folded(entity.name)) ?? deriveIdentityKey({ name: entity.name });
  const ref = entityRef(document.documentId, identityKey);
  const candidate: EntityCandidate = {
    kind: "entity",
    ref,
    source: { documentId: document.documentId, chunkId: null, chunkIndex: chunk.chunkIndex },
    name: entity.name,
    // The extractor's proposal, verbatim: never a catalog entry chosen here, never
    // the reserved unclassified label, never `Concept` (S27).
    proposedType: entity.type,
    description: null,
    properties: [],
  };
  const provenance = provenanceFor(document, { kind: "entity", ref, chunk, quote: entity.name });
  return { candidate, provenance, context: chunk.content };
}

/**
 * One relation's span, keyed by its endpoints and its original predicate.
 *
 * @param document - The constants every span of this document shares.
 * @param relationship - The folded relationship, whose `type` IS the predicate read.
 * @param chunks - The document's stored chunks.
 * @returns The span, or `undefined` when the document produced no chunk at all.
 */
function relationSpan(
  document: DocumentProvenance,
  relationship: ExtractionResult["relationships"][number],
  chunks: readonly ChunkResult[],
): CandidateSpan | undefined {
  const chunk = chunkOf(chunks, relationship.sourceChunkIndices);
  if (chunk === undefined) return undefined;
  const ref = relationRef(
    document.documentId,
    relationship.fromEntityName,
    relationship.type,
    relationship.toEntityName,
  );
  const candidate: RelationCandidate = {
    kind: "relationship",
    ref,
    source: { documentId: document.documentId, chunkId: null, chunkIndex: chunk.chunkIndex },
    fromName: relationship.fromEntityName,
    toName: relationship.toEntityName,
    // The original predicate, required and never defaulted (S30, S31).
    predicate: relationship.type,
    description: null,
  };
  const provenance = provenanceFor(document, {
    kind: "relationship",
    ref,
    chunk,
    quote: relationship.type,
  });
  return { candidate, provenance, context: chunk.content };
}

/**
 * Builds one span per candidate the extraction produced: stage 2 of the pipeline.
 *
 * Entities come first, then relations, each in extraction order, so the batch the
 * classifier receives is deterministic and a test can script it position by
 * position.
 *
 * @param input - The extraction, the stored chunks, the resolved identities.
 * @returns One span per candidate; empty when the document produced no chunk.
 */
export function buildCandidateSpans(input: CandidateBuildInput): readonly CandidateSpan[] {
  const document: DocumentProvenance = {
    documentId: input.documentId,
    catalogVersion: input.catalogVersion,
    pipeline: input.extraction.pipeline,
    model: input.extraction.model,
  };
  const spans: CandidateSpan[] = [];
  for (const entity of input.extraction.entities) {
    const span = entitySpan(document, entity, input.chunks, input.identityKeys);
    if (span !== undefined) spans.push(span);
  }
  for (const relationship of input.extraction.relationships) {
    const span = relationSpan(document, relationship, input.chunks);
    if (span !== undefined) spans.push(span);
  }
  return spans;
}

/**
 * The evidence the classifier is asked against, keyed by candidate ref.
 *
 * @param spans - Stage 2's output.
 * @returns The quote and the stored chunk for every candidate.
 */
export function candidateEvidence(
  spans: readonly CandidateSpan[],
): Readonly<Record<string, CandidateEvidence>> {
  return Object.fromEntries(
    spans.map((span) => [
      span.candidate.ref,
      { quote: span.provenance.evidenceText, context: span.context },
    ]),
  );
}
