/**
 * @file packages/llmwiki-kg/ts/src/core-index.ts
 * @description Library entry point for the vendored AKS knowledge-graph core.
 *
 * The upstream `index.ts` in this package is the standalone HTTP server's
 * startup module: it reads `process.env`, binds a port, and validates provider
 * credentials at import time. Importing THAT from the compiler would boot a
 * server as a side effect of a type import.
 *
 * This barrel exposes only the pure knowledge-graph surface the compiler's
 * `kg` dimension needs — chunking, embedding, extraction, and consolidation —
 * so the compiler can consume the KG in process without starting a server.
 *
 * Nothing here is authored logic: every export is re-exported from upstream
 * `core/` modules. The barrel exists to draw the consumption boundary.
 */

export {
  splitText,
  chunkAndEmbed,
  extractGraphFromChunks,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
} from "./core/extraction.js";

export type {
  ChunkResult,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
} from "./core/extraction.js";

export {
  consolidateEntityRows,
  consolidateRelationshipRows,
} from "./core/document-consolidation.js";
