/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-types.ts
 * @description The shapes the document-compilation pipeline exchanges.
 *
 * Kept apart from the pipeline itself so a consumer (the compiler's `kg`
 * dimension, for one) can type the data without importing chunking, embedding,
 * or any provider call.
 */

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
