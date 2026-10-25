/**
 * @file packages/llmwiki-kg/ts/src/core/graph-extraction.ts
 * @description Graph extraction: chunk batch → triplets → entities and edges.
 *
 * A provider failure or an unparseable response for ONE chunk yields no triplets
 * for that chunk and extraction continues, mirroring the oracle's
 * `except (ValueError, TypeError, AttributeError)` around its structured predict.
 * One bad chunk must not fail a document.
 */

import { config } from "../config.js";
import { callTool } from "./llm_clients.js";
import { buildExtractionPrompt, buildToolSchema } from "./graph-prompt.js";
import {
  parseStandaloneEntities,
  parseTriplets,
  type StandaloneEntity,
  type Triplet,
} from "./graph-parse.js";
import {
  admitStandaloneEntities,
  parseTripletsWithOntology,
  type Ontology,
  type RejectedTriplet,
} from "./ontology.js";
import {
  EXTRACTED_CONFIDENCE,
  EXTRACTION_PIPELINE,
  type ChunkResult,
  type ExtractedEntity,
  type ExtractedRelationship,
  type ExtractionResult,
} from "./extraction-types.js";

/** The result for a document that produced no chunks. */
function emptyResult(): ExtractionResult {
  return {
    entities: [],
    relationships: [],
    model: config.EXTRACTION_MODEL,
    pipeline: EXTRACTION_PIPELINE,
  };
}

/** What one chunk contributed: admitted triplets, what was dropped, and nodes. */
interface ChunkOutput {
  readonly triplets: readonly Triplet[];
  readonly rejected: readonly RejectedTriplet[];
  readonly standalone: readonly StandaloneEntity[];
  /**
   * Endpoints of triplets whose only fault was the relationship.
   *
   * Kept apart from `standalone` because the two arrive from different places —
   * the model's `entities` array versus a rejected triplet — and because the
   * audit report counts them separately.
   */
  readonly rescued: readonly StandaloneEntity[];
}

/**
 * Asks the model for one chunk's triplets, never throwing.
 *
 * llama_index's `except (ValueError, TypeError, AttributeError)` around
 * `astructured_predict`: a provider failure or a response with no tool call
 * yields no triplets for this chunk, and extraction continues.
 */
async function chunkTriplets(
  chunk: ChunkResult,
  stackName: string,
  ontology: Ontology | undefined,
): Promise<ChunkOutput> {
  const prompt = buildExtractionPrompt(chunk.content, chunk.chunkIndex, stackName);
  try {
    const argumentsJson = await callTool(prompt, buildToolSchema(ontology));
    const standalone = standaloneFor(argumentsJson, ontology);
    if (ontology === undefined) {
      return { triplets: parseTriplets(argumentsJson), rejected: [], standalone, rescued: [] };
    }
    return { ...parseTripletsWithOntology(argumentsJson, ontology), standalone };
  } catch {
    // A provider failure yields nothing for this chunk and extraction continues,
    // exactly as the oracle's `except (ValueError, TypeError, AttributeError)`.
    return { triplets: [], rejected: [], standalone: [], rescued: [] };
  }
}

/**
 * Reads the entities that took part in no relationship, enforcing if asked.
 *
 * Separate from the triplet parse because the two have different contracts: the
 * triplet path mirrors the oracle and must keep doing so, while `entities` is an
 * addition with no oracle behaviour to reproduce.
 */
function standaloneFor(
  argumentsJson: string,
  ontology: Ontology | undefined,
): readonly StandaloneEntity[] {
  const parsed = parseStandaloneEntities(argumentsJson);
  return ontology === undefined ? parsed : admitStandaloneEntities(parsed, ontology);
}

/**
 * Folds one endpoint into the entity map.
 *
 * Both endpoints of a triplet become entities; the oracle does the same, which is
 * why `entities_extracted` counts nodes, not triplet subjects.
 */
function absorbEndpoint(
  entityMap: Map<string, ExtractedEntity>,
  name: string,
  type: string,
  chunkIndex: number,
): void {
  const key = name.trim().toLowerCase();
  const existing = entityMap.get(key);
  if (existing === undefined) {
    entityMap.set(key, {
      name,
      type,
      description: "",
      confidence: EXTRACTED_CONFIDENCE,
      sourceChunkIndices: [chunkIndex],
    });
    return;
  }
  if (EXTRACTED_CONFIDENCE > existing.confidence) {
    existing.description = "";
    existing.confidence = EXTRACTED_CONFIDENCE;
    existing.type = type;
  }
  existing.sourceChunkIndices.push(chunkIndex);
}

/** Folds both endpoints of one triplet into the entity map. */
function absorbEndpoints(
  entityMap: Map<string, ExtractedEntity>,
  triplet: Triplet,
  chunkIndex: number,
): void {
  absorbEndpoint(entityMap, triplet.subjectName, triplet.subjectType, chunkIndex);
  absorbEndpoint(entityMap, triplet.objectName, triplet.objectType, chunkIndex);
}

/** One triplet as an extracted relationship. */
function tripletRelationship(
  triplet: Triplet,
  chunkIndex: number,
): ExtractedRelationship {
  return {
    fromEntityName: triplet.subjectName,
    toEntityName: triplet.objectName,
    // Consolidation lowercases this again; keeping the uppercase form here
    // matches the Python value that reaches it.
    type: triplet.relationType,
    description: "",
    confidence: EXTRACTED_CONFIDENCE,
    sourceChunkIndices: [chunkIndex],
  };
}

/** The dedupe key: endpoints and type, case-insensitively, NUL-separated. */
function relationshipKey(relationship: ExtractedRelationship): string {
  return [
    relationship.fromEntityName.toLowerCase(),
    relationship.type.toLowerCase(),
    relationship.toEntityName.toLowerCase(),
  ].join("\u0000");
}

/** Merges duplicate relationships, keeping the highest confidence per key. */
function mergeRelationships(
  relationships: readonly ExtractedRelationship[],
): Map<string, ExtractedRelationship> {
  const merged = new Map<string, ExtractedRelationship>();
  for (const relationship of relationships) {
    const key = relationshipKey(relationship);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, relationship);
      continue;
    }
    if (relationship.confidence > existing.confidence) {
      existing.description = relationship.description;
      existing.confidence = relationship.confidence;
    }
    existing.sourceChunkIndices.push(...relationship.sourceChunkIndices);
  }
  return merged;
}

export async function extractGraphFromChunks(
  chunks: readonly ChunkResult[],
  stackName: string,
  ontology?: Ontology,
): Promise<ExtractionResult> {
  if (chunks.length === 0) {
    return emptyResult();
  }

  const entityMap = new Map<string, ExtractedEntity>();
  const relationshipList: ExtractedRelationship[] = [];
  const rejected: RejectedTriplet[] = [];

  for (const chunk of chunks) {
    const batch = await chunkTriplets(chunk, stackName, ontology);
    rejected.push(...batch.rejected);
    for (const triplet of batch.triplets) {
      absorbEndpoints(entityMap, triplet, chunk.chunkIndex);
      relationshipList.push(tripletRelationship(triplet, chunk.chunkIndex));
    }
    // A standalone entity is absorbed by name, so a node the model reported in
    // both shapes stays one row. The triplet endpoints were absorbed first and
    // `absorbEndpoint` only rewrites a type when confidence strictly increases,
    // which it never does here — so the triplet's type wins, and it is the one a
    // relationship already constrains.
    for (const entity of batch.standalone) {
      absorbEndpoint(entityMap, entity.name, entity.type, chunk.chunkIndex);
    }
    // Endpoints of relationship-only rejections. Both types were already checked
    // by the ontology, so nothing here needs filtering again; what they must NOT
    // do is produce a relationship, which is why they join the entity map only.
    for (const entity of batch.rescued) {
      absorbEndpoint(entityMap, entity.name, entity.type, chunk.chunkIndex);
    }
  }

  return {
    entities: [...entityMap.values()],
    relationships: [...mergeRelationships(relationshipList).values()],
    model: config.EXTRACTION_MODEL,
    pipeline: EXTRACTION_PIPELINE,
    // Reported only when an ontology was enforced, so a default run keeps the
    // oracle's result shape instead of carrying a permanently empty array.
    ...(ontology === undefined ? {} : { rejected }),
  };
}