/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/description.ts
 * @description Grounding one entity's description in its source passages.
 *
 * Split out of `routes/synthesize.ts` as its own unit because it is the concern
 * both endpoints share: the prompt, the shortest-passages chunk search, and the
 * write-back. The backfill and the single-entity route are only selection and
 * response shaping around it.
 */

import { sql } from "drizzle-orm";

import { complete } from "../../core/llm_clients.js";
import { compareCodePoints } from "../../core/page_generator.js";
import type { Database } from "../../db.js";

// ---------------------------------------------------------------------------
// Description synthesis (shared by both endpoints)
// ---------------------------------------------------------------------------

/** Response budget for one description. `complete(prompt, max_tokens=300)`. */
export const SYNTHESIS_MAX_TOKENS = 300;

/**
 * How many grounding chunks one description may see.
 *
 * `order by length(dc.content) asc limit 3` in Python: the three *shortest*
 * passages that mention the entity, because short passages are the densely
 * relevant ones. The order is visible in the prompt, so it is reproduced exactly
 * — including the join, which yields one row per (chunk, source-document) pair
 * and can therefore repeat a chunk.
 */
export const SYNTHESIS_CHUNK_LIMIT = 3;

/** Interpolates the description prompt from its three inputs. */
export function buildSynthesisPrompt(
  entityName: string,
  entityType: string,
  domainContextNames: readonly string[],
  chunkText: string,
): string {
  // `", ".join(sorted(names))` — a code-point sort, then a comma-space join.
  const domainContext = [...domainContextNames].sort(compareCodePoints).join(", ");

  return `You are writing a compiled description for one entity in a knowledge graph.

ENTITY: ${entityName}
TYPE: ${entityType}

OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):
${domainContext}

SOURCE PASSAGES THAT MENTION THIS ENTITY:
${chunkText}

Write a description that is 2-4 sentences, reflects what the passages
say, references siblings naturally when relevant, and contains no
filler. Return ONLY the description as plain prose.`;
}

/** One `ontology_entities` row as the synthesis reads it. */
export type SynthesisEntityRow = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
};

/** The entity being described, or `undefined` when the row is gone. */
async function readSynthesisEntity(
  tx: Database,
  entityId: string,
): Promise<SynthesisEntityRow | undefined> {
  const rows = await tx.execute<SynthesisEntityRow>(sql`
    select name, type from ontology_entities where id = ${entityId}
  `);
  return rows[0];
}

/**
 * The shortest passages that mention the entity, in the oracle's order.
 *
 * `order by length(dc.content) asc limit 3`: the three *shortest* passages,
 * because short passages are the densely relevant ones. The join yields one row
 * per (chunk, source-document) pair and can therefore repeat a chunk — that is
 * the oracle's behaviour and it is preserved.
 */
async function readGroundingChunks(
  tx: Database,
  stackId: string,
  entityId: string,
  entityName: string,
): Promise<string[]> {
  const rows = await tx.execute<{ readonly content: string }>(sql`
    select dc.content
    from document_chunks dc
    join entity_source_documents esd
      on esd.document_id = dc.document_id
      and esd.entity_id = ${entityId}
    where dc.stack_id = ${stackId}
      and dc.content ilike ${`%${entityName}%`}
    order by length(dc.content) asc
    limit ${SYNTHESIS_CHUNK_LIMIT}
  `);
  return rows.map((row) => row.content);
}

/** Stores the synthesized description. `updated_at` is written here, not by a trigger. */
async function writeDescription(
  tx: Database,
  entityId: string,
  description: string,
): Promise<void> {
  await tx.execute(sql`
    update ontology_entities
    set description = ${description},
        updated_at = now()
    where id = ${entityId}
  `);
}

/**
 * `_synthesize_one` — ground one entity's description in its source passages.
 *
 * Returns `true` when a description was written and `false` when there was
 * nothing to ground in (no chunks mention the entity, or the entity is gone).
 * A `false` still commits, which is why the caller counts it as *skipped* rather
 * than as a failure.
 *
 * The chunk search is `content ilike '%<name>%'` against chunks of documents that
 * contributed to the entity, scoped to the Stack. The name is interpolated into
 * the pattern verbatim, so a `%` in an entity name acts as a wildcard — that is
 * the oracle's behaviour and it is preserved, not corrected.
 */
export async function synthesizeOne(
  tx: Database,
  stackId: string,
  entityId: string,
  domainContextNames: readonly string[],
): Promise<boolean> {
  const entity = await readSynthesisEntity(tx, entityId);
  if (entity === undefined) {
    return false;
  }
  const chunks = await readGroundingChunks(tx, stackId, entityId, entity.name);
  if (chunks.length === 0) {
    return false;
  }

  const chunkText = chunks.join("\n\n---\n\n");
  const newDescription = await complete(
    buildSynthesisPrompt(entity.name, entity.type, domainContextNames, chunkText),
    SYNTHESIS_MAX_TOKENS,
  );
  await writeDescription(tx, entityId, newDescription);
  return true;
}
/** Every entity name in the Stack, in the order the domain context uses. */
export async function fetchEntityNames(tx: Database, stackId: string): Promise<string[]> {
  const rows = await tx.execute<{ readonly name: string }>(sql`
    select name from ontology_entities where stack_id = ${stackId}
  `);
  return rows.map((row) => row.name);
}

