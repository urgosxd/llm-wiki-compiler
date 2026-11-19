/**
 * @file packages/llmwiki-kg/ts/src/schema-kg-ontology.ts
 * @description Drizzle mirror of `ontology_entities` and `ontology_relationships`, the two
 * tables that hold the knowledge graph, together with the ontology verdict columns they carry.
 *
 * ## Why this is not in `schema.ts`
 *
 * The same reason `schema-open-classification.ts` is not: `schema.ts` mirrors the tables that
 * predate a change, and the house rules cap a file at 400 lines. Adding the verdict, reason and
 * offending-type columns to both graph tables pushed `schema.ts` past that cap, so the two
 * tables moved here. It is a pure structural extraction — no column, constraint, index or
 * exported name changed — and `schema.ts` re-exports both tables, so every existing import
 * path still resolves.
 *
 * ## The dependency direction is a cycle here, and it is safe
 *
 * `schema-open-classification.ts` can keep its dependency one-way because `schema.ts` imports
 * only TYPES from it. That is not available here: `schema.ts` declares
 * `entity_source_documents` and `entity_pages`, both of which carry a foreign key to
 * `ontology_entities`, and it re-exports `ontologyEntities` for the callers that read the
 * mirror as a namespace. So this module imports `stacks` from `schema.ts` while `schema.ts`
 * imports `ontologyEntities` from this module.
 *
 * What keeps the cycle safe is that nothing here READS a `schema.ts` binding while this module
 * evaluates: every use of `stacks` sits inside a thunk drizzle resolves lazily. `references()`
 * only records the callback (`pg-core/columns/common.js:14-17`), `pgTable` stores the
 * extra-config builder instead of calling it (`pg-core/table.js:45-46`), and `ForeignKeyBuilder`
 * keeps its reference as a function (`pg-core/foreign-keys.js:12-15`) — all drizzle-orm 0.45.4.
 * A future column definition that evaluated a `schema.ts` table at module scope would turn this
 * into a temporal-dead-zone error, which is why the direction is written down here rather than
 * left implicit.
 */
import { sql } from "drizzle-orm";
import type { BuildExtraConfigColumns } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";

import type { ClassificationState, CompatibilityState, SupportState } from "./schema-open-classification.js";
import type { JsonObject, OntologyVerdict } from "./schema.js";
import { stacks } from "./schema.js";

export const ontologyEntities = pgTable(
  "ontology_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description"),
    properties: jsonb("properties")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`),
    confidence: real("confidence").notNull().default(0.5),
    verified: boolean("verified").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    extractedAt: timestamp("extracted_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    extractedByModel: text("extracted_by_model"),
    sourceKind: text("source_kind").default("document"),
    pipeline: text("pipeline").default("llamaindex-schema-extraction"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    // Open-classification columns. `type` above stays the projection/display value;
    // the catalog decision lives in `canonicalType` and is set only while the state is
    // `classified` (see the `canonical_type_requires_classified` check).
    classificationState: text("classification_state").$type<ClassificationState>(),
    canonicalType: text("canonical_type"),
    proposedType: text("proposed_type"),
    supportState: text("support_state").$type<SupportState>(),
    // Raw classifier output with its original meaning. Never folded into `confidence`.
    jevChoice: text("jev_choice"),
    jevConfidence: real("jev_confidence"),
    jevTopProbability: real("jev_top_probability"),
    jevModel: text("jev_model"),
    jevClassifiedAt: timestamp("jev_classified_at", {
      withTimezone: true,
      mode: "string",
    }),
    catalogVersion: text("catalog_version"),
    classifierVersion: text("classifier_version"),
    classificationUpdatedAt: timestamp("classification_updated_at", {
      withTimezone: true,
      mode: "string",
    }),
    // NOT NULL in SQL. Writers that do not supply one get it derived from `name` by
    // the `fill_identity_key` trigger, exactly as the backfill derived it.
    identityKey: text("identity_key").notNull(),
    // The ontology verdict, on its own axis. It is NOT `classificationState` above: that
    // column is the catalog-match vocabulary and `persist-classification.ts` UPDATEs it, so
    // a verdict kept there would be erased. `accepted` is the default because every row
    // that predates the column WAS accepted — a rejected triplet was never written.
    ontologyVerdict: text("ontology_verdict")
      .$type<OntologyVerdict>()
      .notNull()
      .default("accepted"),
    ontologyRejectionReason: text("ontology_rejection_reason"),
    ontologyOffendingType: text("ontology_offending_type"),
  },
  (t) => [
    unique("unique_identity_per_stack").on(t.stackId, t.identityKey),
    check(
      "valid_entity_classification_state",
      sql`${t.classificationState} is null or ${t.classificationState} in ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed')`,
    ),
    check(
      "valid_entity_support_state",
      sql`${t.supportState} is null or ${t.supportState} in ('supported', 'unsupported', 'uncertain')`,
    ),
    check(
      "canonical_type_requires_classified",
      sql`${t.canonicalType} is null or ${t.classificationState} = 'classified'`,
    ),
    check(
      "valid_entity_ontology_verdict",
      sql`${t.ontologyVerdict} in ('accepted', 'rejected')`,
    ),
    check(
      "valid_entity_ontology_rejection_reason",
      sql`${t.ontologyRejectionReason} is null or ${t.ontologyRejectionReason} in ('UNKNOWN_ENTITY_TYPE', 'UNKNOWN_RELATIONSHIP_TYPE', 'SUBJECT_TYPE_NOT_IN_DOMAIN', 'OBJECT_TYPE_NOT_IN_RANGE')`,
    ),
    // An equivalence, not two conditions: rejected implies a reason, accepted implies none.
    check(
      "ontology_rejection_reason_requires_rejected",
      sql`(${t.ontologyVerdict} = 'rejected') = (${t.ontologyRejectionReason} is not null)`,
    ),
    index("idx_entities_stack").on(t.stackId),
    index("idx_entities_type").on(t.type),
    index("idx_entities_stack_name").on(t.stackId, t.name),
    index("idx_entities_ontology_verdict").on(t.stackId, t.ontologyVerdict),
  ],
);

/**
 * Column builders for `ontology_relationships`, named rather than inlined because the
 * constraint builders below are typed from it — see {@link OntologyRelationshipExtraConfigColumns}.
 */
const ontologyRelationshipColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  stackId: uuid("stack_id")
    .notNull()
    .references(() => stacks.id, { onDelete: "cascade" }),
  fromEntityId: uuid("from_entity_id")
    .notNull()
    .references(() => ontologyEntities.id, { onDelete: "cascade" }),
  toEntityId: uuid("to_entity_id")
    .notNull()
    .references(() => ontologyEntities.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  description: text("description"),
  confidence: real("confidence").notNull().default(0.5),
  verified: boolean("verified").notNull().default(false),
  extractedAt: timestamp("extracted_at", {
    withTimezone: true,
    mode: "string",
  })
    .notNull()
    .defaultNow(),
  extractedByModel: text("extracted_by_model"),
  sourceKind: text("source_kind").default("document"),
  pipeline: text("pipeline").default("llamaindex-schema-extraction"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  // The immutable original predicate. `type` above keeps its projection meaning, so a
  // predicate nobody could map ("deja sin efecto") survives instead of collapsing.
  predicate: text("predicate"),
  canonicalType: text("canonical_type"),
  classificationState: text("classification_state").$type<ClassificationState>(),
  supportState: text("support_state").$type<SupportState>(),
  compatibility: text("compatibility").$type<CompatibilityState>(),
  jevChoice: text("jev_choice"),
  jevConfidence: real("jev_confidence"),
  jevTopProbability: real("jev_top_probability"),
  jevModel: text("jev_model"),
  jevClassifiedAt: timestamp("jev_classified_at", {
    withTimezone: true,
    mode: "string",
  }),
  catalogVersion: text("catalog_version"),
  classifierVersion: text("classifier_version"),
  classificationUpdatedAt: timestamp("classification_updated_at", {
    withTimezone: true,
    mode: "string",
  }),
  identityKey: text("identity_key").notNull(),
  // The same verdict axis as `ontologyEntities` above, on the edge's own row.
  ontologyVerdict: text("ontology_verdict")
    .$type<OntologyVerdict>()
    .notNull()
    .default("accepted"),
  ontologyRejectionReason: text("ontology_rejection_reason"),
  ontologyOffendingType: text("ontology_offending_type"),
};

/**
 * The "self" drizzle hands a table's extra-config callback, derived from the column builders
 * above so it cannot drift from them. Referencing a column that `ontologyRelationshipColumns`
 * does not declare is a type error rather than a `undefined` at query time.
 */
type OntologyRelationshipExtraConfigColumns = BuildExtraConfigColumns<
  "ontology_relationships",
  typeof ontologyRelationshipColumns,
  "pg"
>;

/**
 * The two uniqueness rules on the edge identity.
 *
 * `unique_edge_per_stack` is KEPT as well as the identity-key constraint: two consolidators
 * infer their upsert target from `on conflict (stack_id, from_entity_id, to_entity_id, type)`,
 * and dropping the constraint that backs those columns breaks every re-ingest.
 */
function ontologyRelationshipKeyConstraints(
  t: OntologyRelationshipExtraConfigColumns,
): PgTableExtraConfigValue[] {
  return [
    unique("unique_edge_per_stack").on(
      t.stackId,
      t.fromEntityId,
      t.toEntityId,
      t.type,
    ),
    unique("unique_edge_identity_per_stack").on(
      t.stackId,
      t.fromEntityId,
      t.toEntityId,
      t.identityKey,
    ),
  ];
}

/** The catalog-match vocabulary the edge shares with the entity table. */
function ontologyRelationshipStateChecks(
  t: OntologyRelationshipExtraConfigColumns,
): PgTableExtraConfigValue[] {
  return [
    check(
      "valid_relationship_classification_state",
      sql`${t.classificationState} is null or ${t.classificationState} in ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed')`,
    ),
    check(
      "valid_relationship_support_state",
      sql`${t.supportState} is null or ${t.supportState} in ('supported', 'unsupported', 'uncertain')`,
    ),
    check(
      "valid_relationship_compatibility",
      sql`${t.compatibility} is null or ${t.compatibility} in ('compatible', 'conflict', 'indeterminate')`,
    ),
    check(
      "canonical_type_requires_classified",
      sql`${t.canonicalType} is null or ${t.classificationState} = 'classified'`,
    ),
  ];
}

/**
 * The ontology verdict's own rules: a closed class set, a closed reason set, and the
 * equivalence between them.
 */
function ontologyRelationshipVerdictChecks(
  t: OntologyRelationshipExtraConfigColumns,
): PgTableExtraConfigValue[] {
  return [
    check(
      "valid_relationship_ontology_verdict",
      sql`${t.ontologyVerdict} in ('accepted', 'rejected')`,
    ),
    check(
      "valid_relationship_ontology_rejection_reason",
      sql`${t.ontologyRejectionReason} is null or ${t.ontologyRejectionReason} in ('UNKNOWN_ENTITY_TYPE', 'UNKNOWN_RELATIONSHIP_TYPE', 'SUBJECT_TYPE_NOT_IN_DOMAIN', 'OBJECT_TYPE_NOT_IN_RANGE')`,
    ),
    check(
      "ontology_rejection_reason_requires_rejected",
      sql`(${t.ontologyVerdict} = 'rejected') = (${t.ontologyRejectionReason} is not null)`,
    ),
  ];
}

/** The traversal indexes, plus the one that makes a verdict filter a lookup. */
function ontologyRelationshipIndexes(
  t: OntologyRelationshipExtraConfigColumns,
): PgTableExtraConfigValue[] {
  return [
    index("idx_rels_stack").on(t.stackId),
    index("idx_rels_from").on(t.fromEntityId),
    index("idx_rels_to").on(t.toEntityId),
    index("idx_rels_ontology_verdict").on(t.stackId, t.ontologyVerdict),
  ];
}

export const ontologyRelationships = pgTable(
  "ontology_relationships",
  ontologyRelationshipColumns,
  (t) => [
    ...ontologyRelationshipKeyConstraints(t),
    ...ontologyRelationshipStateChecks(t),
    ...ontologyRelationshipVerdictChecks(t),
    ...ontologyRelationshipIndexes(t),
  ],
);
