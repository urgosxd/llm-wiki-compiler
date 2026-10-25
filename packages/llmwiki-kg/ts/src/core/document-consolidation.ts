import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import { bindCallerStack } from "./stack_resolver.js";
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
  // The docstring above promises "a NULL description is treated as empty", and the
  // EntityLookupRow side already guards with `?? ""`. The extracted side did not,
  // so a re-extraction whose model omitted a description crashed on
  // `null.length` — the very case the comment says is supported.
  const extractedDescription = entity.description ?? "";
  const nextDescription =
    extractedDescription !== "" && extractedDescription.length > existingDescription.length
      ? extractedDescription
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
  // Bind the tenant before any write: every statement below is tenant-scoped, so under
  // RLS an unbound insert is refused. `stackId` is already this call's own filter.
  await bindCallerStack(tx, stackId, null);

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
  await bindCallerStack(tx, stackId, null);
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

/** What the compiler knows about a source it wants to register as a document. */
export interface DocumentRegistration {
  /** Stack the document belongs to. */
  readonly stackId: string;
  /** Identity of the source, e.g. its URL or file path. */
  readonly source: string;
  /** Full text that was extracted. */
  readonly body: string;
  /** Human-facing title, used as the stored filename. */
  readonly title: string;
}

/**
 * Register a source as a document row and return its id.
 *
 * WHY THIS EXISTS. `consolidate_entities` writes `entity_source_documents`, whose
 * `document_id` is a FOREIGN KEY onto `stack_documents`. The upstream server only
 * ever inserted that parent row from its HTTP upload handler
 * (`routes/documents/upload.ts`), so the in-process path had no way to satisfy the
 * constraint: every consolidation failed with a foreign-key violation and the
 * graph dimension could never write anything. This closes that gap with the same
 * SQL shape the upload handler uses.
 *
 * IDEMPOTENT ON CONTENT, BY CONSTRUCTION. `stack_documents` carries
 * `unique_hash_per_stack` on `(stack_id, source_hash)`, so re-registering identical
 * content resolves to the SAME row via `on conflict ... do update` and `returning`.
 * The caller therefore never invents an id — Postgres owns it — and a re-ingest
 * cannot fork a second document for unchanged bytes.
 *
 * `source_hash` covers the source identity AND the body: a source whose content
 * changed is a different document, which is what lets the graph hold the current
 * text rather than accumulating stale chunks under one id. A soft delete keys off
 * `source` instead, so `forget` can find every generation of a removed source.
 *
 * @param tx - Transaction that will also carry the consolidation writes.
 * @param registration - Source identity, body, and title.
 * @returns The document row's id.
 */
export async function registerDocumentRow(
  tx: Database,
  registration: DocumentRegistration,
): Promise<string> {
  const sourceHash = createHash("sha256")
    .update(registration.source)
    .update("\u0000")
    .update(registration.body)
    .digest("hex");
  const rows = await tx.execute<{ id: string }>(sql`
    insert into stack_documents (
      stack_id, filename, storage_path, size_bytes, content_type, source_hash
    )
    values (
      ${registration.stackId}, ${registration.title}, ${registration.source},
      ${Buffer.byteLength(registration.body, "utf8")}, 'text/markdown', ${sourceHash}
    )
    on conflict on constraint unique_hash_per_stack
    do update set filename = excluded.filename
    returning id
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stack_documents returned no row");
  }
  return row.id;
}

/**
 * Delete every document row a source owns, letting the foreign keys cascade.
 *
 * WHY `storage_path` IS THE MATCH COLUMN. The compiler has no filename to give the
 * graph, so it registers a document with the SOURCE IDENTITY (a URL or path) in
 * `storage_path`. That column is therefore the only link between a source string
 * and its rows.
 *
 * DELETES ALL GENERATIONS, BY DESIGN. A source whose content changed produces a
 * different `source_hash` and therefore a different row. Forgetting the source
 * must retire every one of them, not only the newest, or the graph keeps serving
 * text the source no longer has.
 *
 * Chunk and `entity_source_documents` rows cascade from `stack_documents`, so this
 * single delete retires the whole trace. Deleting nothing is not an error: the
 * desired end state for an unknown or already-forgotten source already holds.
 *
 * @param tx - Transaction carrying the deletion.
 * @param stackId - Stack the source belongs to; scoping prevents a cross-stack delete.
 * @param source - Source identity recorded at ingest time.
 */
export async function forgetDocumentRows(
  tx: Database,
  stackId: string,
  source: string,
): Promise<void> {
  await tx.execute(sql`
    delete from stack_documents
    where stack_id = ${stackId} and storage_path = ${source}
  `);
}
