import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import { config } from "../config.js";
import type { ExtractedEntity, ExtractedRelationship } from "./extraction.js";

/**
 * @file packages/llmwiki-kg/ts/src/core/document-consolidation.ts
 * @description Document-extraction consolidation: the graph writes performed
 * after a document's chunks have been extracted.
 *
 * These two functions were lifted verbatim out of `routes/ingest.ts` so the
 * compiler's `kg` dimension can drive the same consolidation **in process**,
 * without going through the Express handler. Behaviour is unchanged: the SQL,
 * the confidence arithmetic, and the "written counts attempts" contract are
 * copied as-is, which is what keeps this a move rather than a rewrite.
 *
 * They stay in `core/` (not `routes/`) for the same reason the upstream
 * backfeed half of `consolidation.py` does: this is graph logic, not transport.
 */

type EntityLookupRow = {
  id: string;
  confidence: number;
  description: string | null;
};

/** Confidence bump applied when a re-extraction corroborates an existing entity. */
const ENTITY_CONFIDENCE_BUMP = 0.05;

/** `source_kind` written for every document-derived row. */
const DOCUMENT_SOURCE_KIND = "document";

/** `pipeline` written for every document-derived row. */
const DOCUMENT_PIPELINE = "llamaindex-schema-extraction";

/** The Stack's existing entity with this name, case-insensitively. */
async function findExistingEntity(
  tx: Database,
  stackId: string,
  name: string,
): Promise<EntityLookupRow | undefined> {
  const rows = await tx.execute<EntityLookupRow>(sql`
    select id, confidence, description
    from ontology_entities
    where stack_id = ${stackId} and lower(name) = lower(${name})
  `);
  return rows[0];
}

/**
 * Rewrites an existing entity's confidence, description and freshness.
 *
 * A NULL description is treated as empty and written back as `''`, and the
 * description is replaced only when strictly longer — both measured on the
 * oracle.
 */
async function updateEntity(
  tx: Database,
  entity: ExtractedEntity,
  existing: EntityLookupRow,
): Promise<string> {
  const existingConfidence = Number(existing.confidence);
  const existingDescription = existing.description ?? "";
  const nextConfidence = Math.min(1.0, existingConfidence + ENTITY_CONFIDENCE_BUMP);
  const nextDescription =
    entity.description !== "" && entity.description.length > existingDescription.length
      ? entity.description
      : existingDescription;

  await tx.execute(sql`
    update ontology_entities
    set confidence = ${nextConfidence},
        description = ${nextDescription},
        last_seen_at = now(),
        updated_at = now()
    where id = ${existing.id}
  `);
  return existing.id;
}

/** Inserts a new entity, populating `extracted_by_model` from config. */
async function insertEntity(
  tx: Database,
  stackId: string,
  entity: ExtractedEntity,
): Promise<string> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into ontology_entities (
      stack_id, name, type, description, confidence,
      extracted_by_model, source_kind, pipeline
    )
    values (
      ${stackId}, ${entity.name}, ${entity.type}, ${entity.description},
      ${entity.confidence}, ${config.EXTRACTION_MODEL},
      ${DOCUMENT_SOURCE_KIND}, ${DOCUMENT_PIPELINE}
    )
    returning id
  `);
  const created = inserted[0];
  if (created === undefined) {
    throw new Error("insert into ontology_entities returned no row");
  }
  return created.id;
}

/**
 * Records that `documentId` contributed to `entityId`.
 *
 * `on conflict (entity_id, document_id) do nothing` — a re-ingest does not
 * duplicate the contribution, which is why `entity_source_documents` keeps
 * exactly one row per entity/document pair.
 */
async function recordContribution(
  tx: Database,
  entityId: string,
  documentId: string,
  stackId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into entity_source_documents (entity_id, document_id, stack_id)
    values (${entityId}, ${documentId}, ${stackId})
    on conflict (entity_id, document_id) do nothing
  `);
}

/**
 * `consolidate_entities` — insert or update entities, return the name→id map.
 *
 * Reproduced from `app/core/consolidation.py`, including three details that are
 * observable in the database:
 *
 * 1. **Confidence arithmetic is a double, rounded by `real` on write.** Python
 *    computes `min(1.0, existing + 0.05)` in double precision and psycopg2 sends
 *    it as text; Postgres rounds to the nearest `real`. Reproducing the same
 *    double math keeps stored values identical — `0.7 + 0.05` becomes
 *    `0.75` here exactly as it does there.
 * 2. **A NULL description is rewritten as the empty string.** Python reads
 *    `existing_desc = row["description"] or ""` and writes that back, so an
 *    entity whose description was NULL ends up with `''` after a second ingest.
 *    Measured on the oracle.
 * 3. **The description is replaced only when strictly longer.** `if
 *    ent.description and len(ent.description) > len(existing_desc)`.
 *
 * `extracted_by_model` is populated from `config.EXTRACTION_MODEL` on insert and
 * is **not** touched on update, matching the Python `update` statement.
 *
 * @returns lowercased entity name → entity id, consumed by
 *   {@link consolidateRelationshipRows}.
 */
export async function consolidateEntityRows(
  tx: Database,
  stackId: string,
  documentId: string,
  extracted: readonly ExtractedEntity[],
): Promise<Map<string, string>> {
  const nameToId = new Map<string, string>();

  for (const entity of extracted) {
    const existing = await findExistingEntity(tx, stackId, entity.name);
    const entityId =
      existing === undefined
        ? await insertEntity(tx, stackId, entity)
        : await updateEntity(tx, entity, existing);

    nameToId.set(entity.name.toLowerCase(), entityId);
    await recordContribution(tx, entityId, documentId, stackId);
  }

  return nameToId;
}
/**
 * `consolidate_relationships` — upsert edges, return how many were written.
 *
 * Reproduced from `app/core/consolidation.py`. Three behaviours worth naming:
 *
 * - **Unresolvable endpoints are skipped, not invented.** `from_id` and `to_id`
 *   come only from the map built above, so an edge naming an entity the
 *   extractor never emitted is dropped silently. The Python comment says this
 *   is rare; it is also why `relationships_extracted` can exceed
 *   `relationships_written`.
 * - **The UPSERT takes `greatest()` of the confidences** and rewrites the
 *   description only when the incoming confidence is strictly higher. Because
 *   document extraction always emits 0.7, a re-ingest leaves an existing edge's
 *   description and confidence untouched and still counts as written.
 * - **`written` counts attempts, not changed rows.** An update of an unchanged
 *   edge counts exactly like a fresh insert. This is why the measured re-ingest
 *   shows `relationships_written: 1` while `relationships_in_stack` grows to 2:
 *   the write happened, and the row count grew because the *other* relationship
 *   from the second run was a new edge.
 */
export async function consolidateRelationshipRows(
  tx: Database,
  stackId: string,
  extracted: readonly ExtractedRelationship[],
  nameToId: ReadonlyMap<string, string>,
): Promise<number> {
  let written = 0;

  for (const relationship of extracted) {
    const fromId = nameToId.get(relationship.fromEntityName.toLowerCase());
    const toId = nameToId.get(relationship.toEntityName.toLowerCase());
    if (fromId === undefined || toId === undefined) {
      continue;
    }

    await tx.execute(sql`
      insert into ontology_relationships (
        stack_id, from_entity_id, to_entity_id, type,
        description, confidence, extracted_by_model, source_kind, pipeline
      )
      values (
        ${stackId}, ${fromId}, ${toId}, ${relationship.type},
        ${relationship.description}, ${relationship.confidence},
        ${config.EXTRACTION_MODEL}, ${DOCUMENT_SOURCE_KIND}, ${DOCUMENT_PIPELINE}
      )
      on conflict (stack_id, from_entity_id, to_entity_id, type)
      do update set
        confidence = greatest(
          ontology_relationships.confidence,
          excluded.confidence
        ),
        description = case
          when excluded.confidence > ontology_relationships.confidence
          then excluded.description
          else ontology_relationships.description
        end
    `);
    written += 1;
  }

  return written;
}
