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
  Triplet,
} from "./core/extraction.js";

// Declared ontology and its enforcement (contract core-index.ts@2).
//
// The values matter as much as the types: an ingest path handed a stored JSON
// declaration has to *call* `validateOntology` to turn it into an `Ontology`,
// and a hierarchy-aware read has to call `isEntityTypeAllowed`. Re-exporting
// only the interfaces would compile and do nothing.
export {
  validateOntology,
  isEntityTypeAllowed,
  ancestorsOf,
  parseTripletsWithOntology,
  OntologyError,
} from "./core/ontology.js";

export type {
  Ontology,
  RejectedTriplet,
  OntologyParseResult,
  SubtypeEdge,
  RejectionReason,
} from "./core/ontology.js";

// The stored-column round trip (contract core-index.ts@3).
//
// A consumer that holds the raw `stacks.ontology` value has to turn it into an
// `Ontology`, and the null-versus-absent rule that decides whether enforcement
// applies at all lives in that function, not in the consumer. `toStoredOntology`
// is what strips the derived index before anything is persisted.
export { readStackOntology, toStoredOntology } from "./core/stack_ontology.js";
export type { StoredOntology } from "./core/stack_ontology.js";

export {
  consolidateEntityRows,
  consolidateRelationshipRows,
  registerDocumentRow,
  forgetDocumentRows,
} from "./core/document-consolidation.js";
export type { DocumentRegistration } from "./core/document-consolidation.js";

export { createClient, createDatabase } from "./db.js";
export type { Database } from "./db.js";
export { config as kgConfig } from "./config.js";
export type { Config as KgConfig } from "./config.js";

export {
  parseTypeFilter,
  readEntities,
  readEntityByName,
  traverseGraph,
} from "./core/graph_read.js";
export type {
  GraphReadResult,
  ListEntitiesQuery,
  TraverseAnswer,
  TraverseQuery,
} from "./core/graph_read.js";

export { retrieveRelevantChunks, toVectorLiteral } from "./core/retrieval.js";
export type { RetrievedChunk } from "./core/retrieval.js";

export { embedQuery } from "./core/extraction.js";
export type { AKSEntityDto, AKSRelationshipDto } from "./dto.js";
