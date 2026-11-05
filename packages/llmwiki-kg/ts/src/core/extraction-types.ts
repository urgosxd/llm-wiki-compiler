/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-types.ts
 * @description The shapes the document-compilation pipeline exchanges.
 *
 * Kept apart from the pipeline itself so a consumer (the compiler's `kg`
 * dimension, for one) can type the data without importing chunking, embedding,
 * or any provider call.
 */

import type { RejectedTriplet } from "./ontology.js";

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

/** One chunk of a document, ready to insert into `document_chunks`. */
export interface ChunkResult {
  readonly documentId: string;
  readonly stackId: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly embedding: readonly number[];
  readonly chunkerStrategy: string;
}

/** One entity extracted from one or more chunks, pre-consolidation. */
export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  confidence: number;
  sourceChunkIndices: number[];
}

/** One relationship extracted from one or more chunks, pre-consolidation. */
export interface ExtractedRelationship {
  fromEntityName: string;
  toEntityName: string;
  type: string;
  description: string;
  confidence: number;
  sourceChunkIndices: number[];
}

/** Combined output of an extraction run across all chunks of a document. */
export interface ExtractionResult {
  readonly entities: ExtractedEntity[];
  readonly relationships: ExtractedRelationship[];
  readonly model: string;
  readonly pipeline: string;
  /**
   * Triplets dropped because they violated a caller-declared ontology.
   *
   * Optional, and absent on a run with no ontology, so a default extraction
   * keeps exactly the shape the oracle produced. Present so that a caller who
   * DID declare an ontology can tell a thin extraction from a forbidden one:
   * without it, a document that yielded three entities because the model drifted
   * out of the declared types is indistinguishable from a document that only had
   * three entities in it.
   */
  readonly rejected?: readonly RejectedTriplet[];
  /**
   * Chunks whose extraction failed after every retry was spent.
   *
   * Absent when nothing failed, so the common case keeps the oracle's exact
   * result shape. Present so a caller can tell a thin extraction from an
   * impaired one: a document that yielded 2 entities because it had 2 is not the
   * same as a document that yielded 2 because three of its five chunks never
   * answered.
   *
   * Never present with `entities: []` -- a run where every chunk failed raises
   * instead, because an empty graph is not a degraded result, it is an outage.
   */
  readonly failedChunks?: number;
  /**
   * Chunks whose response arrived intact but carried no usable envelope.
   *
   * Modelled exactly like {@link failedChunks}: absent when nothing was mangled,
   * so a healthy run keeps the oracle's exact result shape. It exists because
   * the two zero-triplet outcomes need different remedies — a failed chunk points
   * at the endpoint or the credential, while a mangled one points at the prompt
   * or the parser, and a run that reported both the same way left the operator
   * guessing which.
   *
   * Never fatal, and therefore never exclusive with `entities: []`: a mangled
   * envelope is a degraded answer, so an all-mangled run returns a result with
   * this count set rather than raising the way `failedChunks` does.
   */
  readonly mangledChunks?: number;
  /**
   * `type` values in the model's payload that the generated schema forbids.
   *
   * Modelled exactly like {@link mangledChunks}: absent when nothing violated, so
   * a healthy run keeps the oracle's exact result shape. It exists because on a
   * provider that treats the schema's `enum` as a hint — everything except
   * strict-capable OpenAI — the model's non-compliance was invisible: the triplet
   * was rejected for an out-of-ontology type, which reads exactly like the model
   * choosing a type the Stack simply does not declare.
   *
   * Counted, never filtered: a violating triplet still travels the normal
   * rejection path, so this counter answers "did the model obey the schema it was
   * shown", and `rejected` keeps answering "what did the ontology turn away".
   *
   * Never present on a strict-provider run (the request already makes an
   * out-of-schema type impossible) and never present without an ontology.
   */
  readonly schemaViolations?: number;
}

/**
 * Confidence assigned to every extracted entity and relationship.
 *
 * Literal in `_entities_from_node` / `_relationships_from_node` in Python. The
 * extractor never asks the model for a confidence, so this constant is the only
 * value that ever reaches consolidation from document extraction.
 */
export const EXTRACTED_CONFIDENCE = 0.7;

/** `pipeline` value written for document-derived rows. */
export const EXTRACTION_PIPELINE = "llamaindex-schema-extraction";
