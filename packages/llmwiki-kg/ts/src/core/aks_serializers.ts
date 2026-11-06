import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Database } from "../db.js";
import { AKSEntity, AKSRelationship } from "../dto.js";
import type { AKSEntityDto, AKSRelationshipDto } from "../dto.js";
import type { ClassificationState, SupportState } from "../schema-open-classification.js";
import { UNCLASSIFIED_ENTITY_TYPE } from "./catalog/types.js";
import { CLASSIFICATION_PROPERTY_KEY, classificationBlock } from "./graph_read.js";

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
 *
 * ## The export projection for classified and free items
 *
 * {@link rowToEntity} and {@link rowToRelationship} stay the plain row-to-wire
 * reshape every read path uses. A bundle export also has to say what the classifier
 * decided about each item, so it goes through {@link rowToExportEntity} and
 * {@link rowToExportRelationship}, which compose those two builders and change
 * exactly three things:
 *
 * 1. **`type`.** A classified item exports its `canonical_type`; a free one keeps
 *    the type or predicate the extractor proposed, never a stand-in. An entity with
 *    nothing to show exports the reserved {@link UNCLASSIFIED_ENTITY_TYPE} label,
 *    which is this application's convention and not an AKS vocabulary entry.
 * 2. **`confidence`.** One documented formula, never a raw JEV number. See below.
 * 3. **`properties.classification`.** Entities only, because only entities may
 *    carry it.
 *
 * ### Where the classification metadata may travel
 *
 * The vendored `SCHEMA.json` permits `additionalProperties: true` inside
 * `AKSEntity.properties`, and it forbids extra keys on `AKSRelationship`
 * (`additionalProperties: false`, and no `properties` field at all). So an entity's
 * classification travels under ONE key, while a relationship's classification stays
 * entirely in our own columns (`canonical_type`, `classification_state`,
 * `support_state`, `compatibility`, `jev_*`) and is exposed through our own query
 * surface. Nothing is smuggled into an AKS relationship.
 *
 * That key is NOT this file's to name. `core/graph_read.ts` owns it
 * (`CLASSIFICATION_PROPERTY_KEY`, `kg_classification`) and owns the block's shape and
 * the `reason` vocabulary, and this projection publishes the very block that read path
 * builds — {@link classificationBlock} — so an exported entity and a queried entity
 * describe one row's decision the same way. The export extends it additively with what
 * only a bundle needs: the catalog and classifier versions that produced the decision,
 * and the vendor's raw JEV answer under its original name.
 *
 * `properties.kg_classification` is this application's extension point: that keyspace
 * is reserved, so a stored value under it is replaced by the projection rather than
 * merged. Every other stored property survives untouched, and a row with NO recorded
 * decision publishes no block at all — a hollow block would be a claim.
 *
 * ### The confidence formula
 *
 * `aks_confidence = clamp01(extraction_confidence x support_factor)`, where
 * `extraction_confidence` is the row's stored `confidence` — what the extractor said
 * — and `support_factor` is `supported: 1`, `uncertain: 0.75`, `unsupported: 0.25`.
 * A row with no recorded support judgement keeps factor 1: nobody asked the support
 * question, and an absent judgement is not evidence against the claim.
 *
 * What it measures: how strongly the source evidence corroborates the fact — the
 * extractor's own strength, reduced only when the evidence was judged NOT to
 * corroborate it. It never reads `jev_confidence` or `jev_top_probability` (those
 * are the vendor's dispersion measures for a label decision, not a measure of
 * corroboration), and it does not depend on `classification_state`, because a free
 * item is not a false one and must not be discounted for being free.
 *
 * ### `source.verified` is pass-through
 *
 * Only human review sets it. Nothing in this module infers, upgrades or computes it:
 * the stored column is serialized as-is, so an ingested row exports `false` and an
 * approved backfeed row exports `true`.
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
 * How strongly the source evidence corroborates the fact, as a multiplier on the
 * extractor's own confidence. The formula is in the file header.
 *
 * - `supported`   the evidence corroborates the claim, so nothing is reduced.
 * - `uncertain`   the evidence neither clearly supports nor refutes it: x 0.75.
 * - `unsupported` the evidence was judged not to support it: x 0.25. Not 0, because
 *   the extractor did read real text and the relative order of two such facts still
 *   carries information.
 */
export const SUPPORT_CONFIDENCE_FACTORS: Readonly<Record<SupportState, number>> = Object.freeze({
  supported: 1,
  uncertain: 0.75,
  unsupported: 0.25,
});

/**
 * The factor for a row with no support judgement recorded.
 *
 * An absent judgement is not evidence against the claim, so the extraction
 * confidence stands unchanged rather than being silently penalized as `uncertain`.
 */
export const UNJUDGED_SUPPORT_FACTOR = 1;

/**
 * Decimal places the projected confidence is rounded to.
 *
 * Six is more precision than any threshold in this system uses, and it removes binary
 * noise: `0.6 x 0.75` is `0.44999999999999996` in IEEE 754, and a wire value that reads
 * `0.45` is the one a human can check against the documented formula. The SQL filter
 * rounds the same way, so the number a client filters on is the number it receives.
 */
export const CONFIDENCE_DECIMALS = 6;

/** The classification columns a projected entity carries. */
type EntityClassificationColumns = {
  readonly canonical_type: string | null;
  readonly proposed_type: string | null;
  readonly classification_state: ClassificationState | null;
  readonly support_state: SupportState | null;
  readonly catalog_version: string | null;
  readonly classifier_version: string | null;
  readonly jev_choice: string | null;
  readonly jev_confidence: number | null;
  readonly jev_top_probability: number | null;
  readonly jev_model: string | null;
  readonly jev_classified_at: string | null;
};

/** The classification columns a projected relationship carries (AKS forbids `proposed_type`-style extras). */
type RelationshipClassificationColumns = Omit<EntityClassificationColumns, "proposed_type">;

/** An `ontology_entities` row as {@link EXPORT_ENTITY_COLUMNS} selects it. */
export type ExportEntityRow = EntityRow & EntityClassificationColumns;

/** An `ontology_relationships` row as {@link EXPORT_RELATIONSHIP_COLUMNS} selects it. */
export type ExportRelationshipRow = RelationshipRow &
  RelationshipClassificationColumns & {
    readonly predicate: string | null;
  };

/** {@link ENTITY_COLUMNS} plus the classification columns the projection reads. */
export const EXPORT_ENTITY_COLUMNS =
  `${ENTITY_COLUMNS}, canonical_type, proposed_type, classification_state, support_state, ` +
  "catalog_version, classifier_version, jev_choice, jev_confidence, jev_top_probability, " +
  "jev_model, jev_classified_at";

/** {@link RELATIONSHIP_COLUMNS} plus the immutable predicate and the classification columns. */
export const EXPORT_RELATIONSHIP_COLUMNS =
  `${RELATIONSHIP_COLUMNS}, predicate, canonical_type, classification_state, support_state, ` +
  "catalog_version, classifier_version, jev_choice, jev_confidence, jev_top_probability, " +
  "jev_model, jev_classified_at";

/** True when `value` is one of the three semantic-support states. */
function isSupportState(value: string | null | undefined): value is SupportState {
  return value === "supported" || value === "uncertain" || value === "unsupported";
}

/**
 * The AKS `confidence` of one row: `clamp01(extraction confidence x support factor)`.
 *
 * It measures how strongly the source evidence corroborates the fact, so it is the
 * extractor's own confidence reduced by the support verdict and by nothing else. It
 * never reads a JEV number and never looks at the classification state.
 *
 * @param extractionConfidence - The row's stored `confidence`. A non-finite value (a
 *   driver handing back text) counts as 0 rather than reaching the response.
 * @param supportState - The stored support verdict, or `null` when none was recorded.
 * @returns A deterministic number in `[0, 1]`.
 */
export function aksConfidence(
  extractionConfidence: number,
  supportState: string | null | undefined,
): number {
  const base = Number.isFinite(extractionConfidence) ? extractionConfidence : 0;
  const factor = isSupportState(supportState)
    ? SUPPORT_CONFIDENCE_FACTORS[supportState]
    : UNJUDGED_SUPPORT_FACTOR;
  const scale = 10 ** CONFIDENCE_DECIMALS;
  return Math.round(Math.min(1, Math.max(0, base * factor)) * scale) / scale;
}

/**
 * {@link aksConfidence} as a SQL expression, so a filter sees the number the response shows.
 *
 * `min_confidence` filters this expression rather than the raw column: a client asking
 * for `>= 0.5` must never receive an item whose exported confidence is `0.375`. The
 * factors come from {@link SUPPORT_CONFIDENCE_FACTORS}, so the SQL and the serializer
 * cannot drift apart. The literals are safe to inline because they come from that
 * frozen constant map and never from input.
 *
 * @param confidenceColumn - Column holding the extractor's confidence.
 * @param supportColumn - Column holding the support verdict.
 * @returns A SQL chunk evaluating to the projected confidence.
 */
export function aksConfidenceSql(
  confidenceColumn = "confidence",
  supportColumn = "support_state",
): SQL {
  const states = Object.keys(SUPPORT_CONFIDENCE_FACTORS) as readonly SupportState[];
  const branches = states.map((state) =>
    sql.raw(`when '${state}' then ${SUPPORT_CONFIDENCE_FACTORS[state]}`),
  );
  const product = sql`${sql.raw(confidenceColumn)} * case ${sql.raw(supportColumn)} ${sql.join(
    branches,
    sql` `,
  )} else ${sql.raw(String(UNJUDGED_SUPPORT_FACTOR))} end`;
  return sql`round((least(1.0, greatest(0.0, ${product})))::numeric, ${sql.raw(
    String(CONFIDENCE_DECIMALS),
  )})::double precision`;
}

/**
 * The block exported inside `properties.kg_classification`.
 *
 * {@link classificationBlock} is the read path's own builder, so `state`, `classified`,
 * `is_free`, `reason` and the three stored columns are produced by the same code that
 * answers `GET /aks/v1/entities` — no second spelling of the state vocabulary. This
 * function adds only the export's own provenance: the catalog and classifier versions
 * behind the decision, and the vendor's raw JEV answer under its original names.
 *
 * @param row - The classification columns of one entity row.
 * @returns The block, or `null` when the row carries no recorded decision — in which
 *   case the caller must publish nothing rather than an empty object.
 */
export function classificationProperties(
  row: EntityClassificationColumns,
): Record<string, unknown> | null {
  const block = classificationBlock(row);
  if (block === null) return null;
  return {
    ...block,
    catalog_version: row.catalog_version,
    classifier_version: row.classifier_version,
    jev_choice: row.jev_choice,
    jev_confidence: row.jev_confidence,
    jev_top_probability: row.jev_top_probability,
    jev_model: row.jev_model,
    jev_classified_at: row.jev_classified_at,
  };
}

/** The first value that is a non-blank string, returned byte-for-byte. */
function firstNonBlank(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * The `type` one entity exports.
 *
 * A classified row exports its canonical type. A free row exports what the extractor
 * proposed, so the knowledge stays searchable under the label it was found with. A
 * row with a recorded decision but no proposal exports the reserved
 * {@link UNCLASSIFIED_ENTITY_TYPE} label. A row with NO recorded decision at all is a
 * pre-classification row, and it exports the label it was accepted with — the same
 * value the migration's backfill makes its canonical type — instead of being relabeled.
 */
export function projectedEntityType(row: ExportEntityRow): string {
  const block = classificationBlock(row);
  if (block?.state === "classified") {
    // The schema constrains canonical_type to be non-null here; `type` is the guard.
    return firstNonBlank(block.canonical_type, row.type) ?? UNCLASSIFIED_ENTITY_TYPE;
  }
  const undecided = block === null ? row.type : null;
  return firstNonBlank(row.proposed_type, undecided) ?? UNCLASSIFIED_ENTITY_TYPE;
}

/**
 * The `type` one relationship exports.
 *
 * A classified edge exposes its canonical type. A free edge exposes its ORIGINAL
 * predicate verbatim, which is how the wire keeps `deja sin efecto` as `deja sin
 * efecto` instead of collapsing it into a generic verb.
 */
export function projectedRelationType(row: ExportRelationshipRow): string {
  if (row.classification_state === "classified") {
    return firstNonBlank(row.canonical_type, row.predicate, row.type) ?? row.type;
  }
  return firstNonBlank(row.predicate, row.type) ?? row.type;
}

/**
 * `rowToEntity` plus the classification projection: wire type, documented confidence,
 * and the `properties.classification` block.
 *
 * Composing the plain builder keeps one reshape for the fields the two paths share,
 * and re-parsing through `AKSEntity` keeps the JSON key order owned by `dto.ts`.
 */
export function rowToExportEntity(
  row: ExportEntityRow,
  contributingDocuments: readonly string[],
): AKSEntityDto {
  const entity = rowToEntity(row, contributingDocuments);
  const stored = isPlainObject(row.properties) ? row.properties : {};
  const block = classificationProperties(row);
  const properties =
    block === null ? stored : { ...stored, [CLASSIFICATION_PROPERTY_KEY]: block };
  return AKSEntity.parse({
    ...entity,
    type: projectedEntityType(row),
    confidence: aksConfidence(row.confidence, row.support_state),
    properties,
  });
}

/**
 * `rowToRelationship` plus the classification projection.
 *
 * No metadata is added: `AKSRelationship` has `additionalProperties: false` and no
 * `properties` field, so a relationship's classification stays in our own columns.
 */
export function rowToExportRelationship(row: ExportRelationshipRow): AKSRelationshipDto {
  const relationship = rowToRelationship(row);
  return AKSRelationship.parse({
    ...relationship,
    type: projectedRelationType(row),
    confidence: aksConfidence(row.confidence, row.support_state),
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
