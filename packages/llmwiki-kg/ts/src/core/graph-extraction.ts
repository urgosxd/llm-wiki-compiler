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
import { buildExtractionPrompt, KG_TOOL } from "./graph-prompt.js";
import { parseTriplets, type Triplet } from "./graph-parse.js";
import {
  EXTRACTED_CONFIDENCE,
  EXTRACTION_PIPELINE,
  type ChunkResult,
  type ExtractedEntity,
  type ExtractedRelationship,
  type ExtractionResult,
} from "./extraction-types.js";

export async function extractGraphFromChunks(
  chunks: readonly ChunkResult[],
  stackName: string,
): Promise<ExtractionResult> {
  if (chunks.length === 0) {
    return {
      entities: [],
      relationships: [],
      model: config.EXTRACTION_MODEL,
      pipeline: EXTRACTION_PIPELINE,
    };
  }

  const entityMap = new Map<string, ExtractedEntity>();
  const relationshipList: ExtractedRelationship[] = [];

  for (const chunk of chunks) {
    const prompt = buildExtractionPrompt(chunk.content, chunk.chunkIndex, stackName);

    let triplets: Triplet[];
    try {
      triplets = parseTriplets(await callTool(prompt, KG_TOOL));
    } catch {
      // llama_index's `except (ValueError, TypeError, AttributeError)` around
      // `astructured_predict`: a provider failure or a response with no tool
      // call yields no triplets for this chunk, and extraction continues.
      triplets = [];
    }

    for (const triplet of triplets) {
      // Both endpoints of a triplet become entities; the oracle does the same,
      // which is why `entities_extracted` counts nodes, not triplet subjects.
      for (const endpoint of [
        { name: triplet.subjectName, type: triplet.subjectType },
        { name: triplet.objectName, type: triplet.objectType },
      ]) {
        const key = endpoint.name.trim().toLowerCase();
        const existing = entityMap.get(key);
        if (existing === undefined) {
          entityMap.set(key, {
            name: endpoint.name,
            type: endpoint.type,
            description: "",
            confidence: EXTRACTED_CONFIDENCE,
            sourceChunkIndices: [chunk.chunkIndex],
          });
        } else {
          if (EXTRACTED_CONFIDENCE > existing.confidence) {
            existing.description = "";
            existing.confidence = EXTRACTED_CONFIDENCE;
            existing.type = endpoint.type;
          }
          existing.sourceChunkIndices.push(chunk.chunkIndex);
        }
      }

      relationshipList.push({
        fromEntityName: triplet.subjectName,
        toEntityName: triplet.objectName,
        // Consolidation lowercases this again; keeping the uppercase form here
        // matches the Python value that reaches it.
        type: triplet.relationType,
        description: "",
        confidence: EXTRACTED_CONFIDENCE,
        sourceChunkIndices: [chunk.chunkIndex],
      });
    }
  }

  const relationshipMap = new Map<string, ExtractedRelationship>();
  for (const relationship of relationshipList) {
    const key = [
      relationship.fromEntityName.toLowerCase(),
      relationship.type.toLowerCase(),
      relationship.toEntityName.toLowerCase(),
    ].join("\u0000");

    const existing = relationshipMap.get(key);
    if (existing === undefined) {
      relationshipMap.set(key, relationship);
      continue;
    }
    if (relationship.confidence > existing.confidence) {
      existing.description = relationship.description;
      existing.confidence = relationship.confidence;
    }
    existing.sourceChunkIndices.push(...relationship.sourceChunkIndices);
  }

  return {
    entities: [...entityMap.values()],
    relationships: [...relationshipMap.values()],
    model: config.EXTRACTION_MODEL,
    pipeline: EXTRACTION_PIPELINE,
  };
}
