import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import { AKSEntity, AKSRelationship } from "../dto.js";
import type { AKSEntityDto, AKSRelationshipDto } from "../dto.js";

/**
 * Reshape ontology rows into the nested AKS response models.
 *
 * TypeScript port of `app/core/aks_serializers.py`. Database rows are flat; AKS
 * entities carry a nested `source` block plus a `contributing_documents` array
 * fetched from a join table, so every read path needs the same two transforms.
 *
 * ## Why the DTO schema does the reshaping
 *
 * Each builder hands its hand-assembled object to the Zod schema
 * (`AKSEntity.parse` / `AKSRelationship.parse`), exactly like Python's
 * `AKSEntity(**row)`. The schema both validates and fixes the JSON key order, so
 * the response order comes from `dto.ts`'s declaration order — the same source
 * as the oracle's — rather than from whatever order this file happens to write.
 *
 * ## `document_id` and `connector_id` are always `null`
 *
 * `AKSSource` declares them, but `ontology_entities` and
 * `ontology_relationships` have no such columns: provenance is carried by
 * `entity_source_documents` and surfaced separately as `contributing_documents`.
 * The Python builder never passes them, so they take the model's `None` default.
 * Nothing is invented here.
 */

/**
 * Columns every entity read selects, in the Python handlers' order.
 *
 * Repeated verbatim in four queries across this slice (list, single, context,
 * export), which is why it lives here. Order is not observable in the response —
 * the DTO fixes that — but keeping it identical to Python keeps the two
 * statements diffable.
 */
export const ENTITY_COLUMNS =
  "id, name, type, description, properties, confidence, verified, last_seen_at, " +
  "extracted_at, extracted_by_model, source_kind, pipeline";

/** Columns every relationship read selects, in the Python handlers' order. */
export const RELATIONSHIP_COLUMNS =
  "id, from_entity_id, to_entity_id, type, description, confidence, verified, " +
  "extracted_at, extracted_by_model, source_kind, pipeline";

/**
 * An `ontology_entities` row as {@link ENTITY_COLUMNS} selects it.
 *
 * `properties` is `jsonb`: postgres-js hands back an already-parsed value, so it
 * is typed `unknown` and narrowed by the `or {}` rule in {@link rowToEntity}.
 * `confidence` is a Postgres `real`, which postgres-js delivers as a `number`.
 */
export type EntityRow = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties: unknown;
  confidence: number;
  verified: boolean;
  last_seen_at: string | null;
  extracted_at: string | null;
  extracted_by_model: string | null;
  source_kind: string | null;
  pipeline: string | null;
};

/** An `ontology_relationships` row as {@link RELATIONSHIP_COLUMNS} selects it. */
export type RelationshipRow = {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  type: string;
  description: string | null;
  confidence: number;
  verified: boolean;
  extracted_at: string | null;
  extracted_by_model: string | null;
  source_kind: string | null;
  pipeline: string | null;
};

/** True when `value` is a plain JSON object, which is what `properties` must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `row_to_entity` — one entity row plus its contributing document ids.
 *
 * Three details are contractual because they are observable in the JSON:
 *
 * 1. **`properties` falls back to `{}` for SQL NULL.** Python writes
 *    `row.get("properties") or {}`; the column is `jsonb` with a `'{}'` default,
 *    but a hand-written NULL must still serialize as an empty object rather than
 *    `null`.
 * 2. **`confidence` is coerced to a float.** `real` arrives as a JavaScript
 *    number already; `Number(...)` keeps the Python `float(row["confidence"])`
 *    intent explicit and guards a driver that ever returns numeric text.
 * 3. **`verified` is `bool(...)` of the column, defaulting to `false`.** The
 *    column is `NOT NULL DEFAULT false`, so the default only matters for a
 *    projection that omits it.
 */
export function rowToEntity(
  row: EntityRow,
  contributingDocuments: readonly string[],
): AKSEntityDto {
  return AKSEntity.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    properties: isPlainObject(row.properties) ? row.properties : {},
    confidence: Number(row.confidence),
    contributing_documents: [...contributingDocuments],
    last_seen_at: row.last_seen_at,
    source: {
      source_kind: row.source_kind,
      extracted_at: row.extracted_at,
      model: row.extracted_by_model,
      verified: Boolean(row.verified),
      pipeline: row.pipeline,
    },
  });
}

/** `row_to_relationship` — one relationship row, reshaped into the nested model. */
export function rowToRelationship(row: RelationshipRow): AKSRelationshipDto {
  return AKSRelationship.parse({
    id: row.id,
    from_entity_id: row.from_entity_id,
    to_entity_id: row.to_entity_id,
    type: row.type,
    description: row.description,
    confidence: Number(row.confidence),
    source: {
      source_kind: row.source_kind,
      extracted_at: row.extracted_at,
      model: row.extracted_by_model,
      verified: Boolean(row.verified),
      pipeline: row.pipeline,
    },
  });
}

/**
 * Renders a `text[]` / `uuid[]` parameter the way Postgres reads it: `{a,b}`.
 *
 * Drizzle's `sql` tag expands a JavaScript array into a parenthesised list of
 * placeholders (`($1, $2)`), which is a row constructor — `any(($1, $2)::uuid[])`
 * makes Postgres parse `$1` as an array literal and fail with
 * `malformed array literal: "74f2…"`. Measured, not assumed.
 *
 * The value therefore travels as a single text parameter holding one array
 * literal, and the statement casts it (`::uuid[]` / `::text[]`). Elements are
 * double-quoted with `\` and `"` escaped, which is Postgres' own array-literal
 * quoting, so a name containing a comma, a brace or a quote stays one element.
 */
export function toPostgresArrayLiteral(values: readonly string[]): string {
  const quoted = values.map(
    (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return `{${quoted.join(",")}}`;
}

/**
 * Batch-fetch `contributing_documents` for a set of entity ids.
 *
 * Returns entity id -> document ids, in `contributed_at` order.
 *
 * Doing this once per request rather than once per entity is what avoids an N+1
 * when listing entities; a 100-entity list costs two queries, not 101.
 *
 * The query is scoped by entity id only — exactly like Python — and not by
 * `stack_id`. That is safe because entity ids are UUID primary keys, so the
 * join table cannot contain a row for an entity outside the caller's Stack.
 */
export async function fetchContributingDocuments(
  tx: Database,
  entityIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (entityIds.length === 0) {
    return out;
  }

  const rows = await tx.execute<{ entity_id: string; document_id: string }>(sql`
    select entity_id, document_id
    from entity_source_documents
    where entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
    order by contributed_at
  `);

  for (const row of rows) {
    const existing = out.get(row.entity_id);
    if (existing === undefined) {
      out.set(row.entity_id, [row.document_id]);
    } else {
      existing.push(row.document_id);
    }
  }

  return out;
}
