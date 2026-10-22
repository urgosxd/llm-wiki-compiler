/**
 * @file packages/llmwiki-kg/ts/src/core/extraction.ts
 * @description Document compilation pipeline — public surface.
 *
 * TypeScript port of `app/core/extraction.py`. **This port removes LlamaIndex
 * entirely**: chunking, embedding and graph extraction are plain TypeScript that
 * talks to the gateway over HTTP.
 *
 * The pipeline was split into focused modules to keep each file under the
 * project's size limits. This module stays the single import site, so callers
 * are unaffected:
 *
 * | Step | Module |
 * | --- | --- |
 * | Shared shapes | `extraction-types.ts` |
 * | 1. Token counting | `tokenizer.ts` |
 * | 2. Sentence segmentation | `sentence-splitter.ts` |
 * | 3. Chunking | `chunking.ts` |
 * | 4. Chunk and embed | `embedding.ts` |
 * | 5. Extraction prompt + tool | `graph-prompt.ts` |
 * | 5. Triplet parsing | `graph-parse.ts` |
 * | 5. Graph extraction | `graph-extraction.ts` |
 * | 6. Description synthesis | `description-synthesis.ts` |
 *
 * Public functions mirror the Python ones, one for one:
 *
 *   chunkAndEmbed(text, stackId, documentId)     -> ChunkResult[]
 *   embedQuery(text)                             -> number[]
 *   extractGraphFromChunks(chunks, stackName)    -> ExtractionResult
 *   synthesizeEntityDescriptions(result, chunks) -> void
 */

export type {
  ChunkResult,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
} from "./extraction-types.js";

export { countTokens } from "./tokenizer.js";

export {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  splitText,
} from "./chunking.js";
export type { TokenCounter } from "./chunking.js";

export { chunkAndEmbed, embedQuery } from "./embedding.js";

export { buildExtractionPrompt, KG_TOOL } from "./graph-prompt.js";
export { parseTriplets } from "./graph-parse.js";
export type { Triplet } from "./graph-parse.js";

export { extractGraphFromChunks } from "./graph-extraction.js";

export { synthesizeEntityDescriptions } from "./description-synthesis.js";
