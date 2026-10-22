/**
 * @file packages/llmwiki-kg/ts/src/core/description-synthesis.ts
 * @description Optional second pass that rewrites entity descriptions.
 *
 * Off by default. When a stack enables it, each entity's description is
 * regenerated from the chunks that mentioned it, which costs one completion per
 * entity — the reason it is opt-in rather than automatic.
 */

import { complete } from "./llm_clients.js";
import type {
  ChunkResult,
  ExtractedEntity,
  ExtractionResult,
} from "./extraction-types.js";

// ===========================================================================
// STEP 6: OPTIONAL DESCRIPTION SYNTHESIS
// ===========================================================================

/** `max_tokens=300`, from `complete(prompt, max_tokens=300)` in Python. */
const SYNTHESIS_MAX_TOKENS = 300;

/** Maximum source passages included in one synthesis prompt. */
const SYNTHESIS_MAX_CHUNKS = 3;

/**
 * The entity's source passages, joined the way Python joins them.
 *
 * @returns `undefined` when the entity has no resolvable chunk, which is the
 *   skip condition.
 */
function sourceChunkText(
  entity: ExtractedEntity,
  chunkByIndex: ReadonlyMap<number, string>,
): string | undefined {
  const relevantChunks: string[] = [];
  for (const index of entity.sourceChunkIndices) {
    const content = chunkByIndex.get(index);
    if (content !== undefined) {
      relevantChunks.push(content);
    }
  }
  if (relevantChunks.length === 0) {
    return undefined;
  }
  return relevantChunks.slice(0, SYNTHESIS_MAX_CHUNKS).join("\n\n---\n\n");
}

/** The per-entity description prompt, verbatim. */
function buildDescriptionPrompt(
  entity: ExtractedEntity,
  domainContext: string,
  chunkText: string,
): string {
  return `You are writing a compiled description for one entity in a knowledge graph.

ENTITY: ${entity.name}
TYPE: ${entity.type}

OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):
${domainContext}

SOURCE PASSAGES THAT MENTION THIS ENTITY:
${chunkText}

Write a description of this entity that:
- Is 2-4 sentences. Not longer.
- Reflects what the source passages say about this specific entity.
- Naturally references other entities in the domain when relevant.
- Is precise. No filler, no hedging, no "this entity is..." preamble.

Return ONLY the description as plain prose.`;
}

/**
 * Fills `description` on every entity in `result`, in place.
 *
 * Mirrors `synthesize_entity_descriptions`, including its cost profile: **one
 * LLM call per entity**, which is why it is opt-in via the Stack column or the
 * per-call query parameter.
 *
 * The prompt is reproduced verbatim, because the wording is what keeps the
 * output to 2-4 sentences of plain prose. The three source chunks are joined
 * with `"\n\n---\n\n"`, as in Python.
 *
 * Entities with no resolvable source chunk are skipped, and an empty result is
 * a no-op — both matching the Python guards.
 */
export async function synthesizeEntityDescriptions(
  result: ExtractionResult,
  chunks: readonly ChunkResult[],
): Promise<void> {
  if (result.entities.length === 0 || chunks.length === 0) {
    return;
  }

  const chunkByIndex = new Map<number, string>();
  for (const chunk of chunks) {
    chunkByIndex.set(chunk.chunkIndex, chunk.content);
  }

  // `sorted({e.name for e in entities})` — a set, so duplicates collapse, then
  // lexicographic order.
  const domainContext = [...new Set(result.entities.map((entity) => entity.name))]
    .sort()
    .join(", ");

  for (const entity of result.entities) {
    const chunkText = sourceChunkText(entity, chunkByIndex);
    if (chunkText === undefined) {
      continue;
    }
    entity.description = await complete(
      buildDescriptionPrompt(entity, domainContext, chunkText),
      SYNTHESIS_MAX_TOKENS,
    );
  }
}