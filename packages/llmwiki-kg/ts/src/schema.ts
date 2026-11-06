import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of `db/schema.sql`.
 *
 * Every table, column name, nullability rule, default, CHECK constraint,
 * UNIQUE constraint, and index that Drizzle can express is reproduced here
 * exactly as the SQL defines it. The two index families Drizzle cannot
 * express (pgvector HNSW and pg_trgm GIN) are exported as documented raw SQL
 * below — see {@link UNEXPRESSED_INDEXES_SQL}.
 *
 * ## Timestamps are strings, never `Date`
 *
 * Every `timestamptz` column uses `mode: "string"`, so the TS surface types it
 * as `string`. That is deliberate and load-bearing: Postgres carries
 * microsecond precision and `Date.prototype.toISOString()` emits exactly three
 * fractional digits, so letting a timestamp round-trip through `Date` silently
 * destroys the last three digits. See `odd/findings/timestamp-precision.md` and
 * the normalization note in `db.ts`.
 *
 * ## Deliberate non-decisions
 *
 * `stacks.compilation_strategy` is NULLABLE in SQL (it has a default but no
 * NOT NULL), even though `StackCreate` requires it in the API layer. The
 * schema mirrors the database, which is the source of truth; the strictness
 * decision belongs to the DTO layer (T0.6), not here.
 */

/**
 * Shape of `backfeed_queue.proposal`, copied from the SQL comment block in
 * `db/schema.sql`. Either array may be absent; both may be present.
 */
export interface BackfeedProposal {
  entities?: BackfeedProposalEntity[];
  relationships?: BackfeedProposalRelationship[];
}

export interface BackfeedProposalEntity {
  name: string;
  type: string;
  description?: string | undefined;
  confidence?: number | undefined;
}

export interface BackfeedProposalRelationship {
  from: string;
  to: string;
  type: string;
  description?: string | undefined;
  confidence?: number | undefined;
}

/** Free-form JSONB payloads. Structure is validated by the DTO layer. */
export type JsonObject = Record<string, unknown>;

/**
 * The classification state of an entity or a relationship.
 *
 * `null` in the database means "no decision was ever recorded", which is a different
 * fact from every value here and must not be collapsed into one of them:
 *
 * - `classified`     a catalog type was assigned, so `canonical_type` is set.
 * - `free_no_match`  the classifier abstained: nothing in the catalog fits.
 * - `free_uncertain` the classifier could not decide: ambiguous or insufficient.
 * - `pending`        the classifier has not answered yet.
 * - `failed`         the classifier failed or exhausted its retries.
 *
 * "Free" means no catalog type could be assigned. It never means false, invalid, or
 * awaiting human review, and it is not a reason to hide the row from reads.
 */
export type ClassificationState =
  | "classified"
  | "free_no_match"
  | "free_uncertain"
  | "pending"
  | "failed";

/**
 * Whether the quoted source evidence supports the claim (S20's closed set).
 *
 * Deliberately separate from every confidence measure: "the source backs this" and
 * "the classifier is sure of the label" are different facts.
 */
export type SupportState = "supported" | "unsupported" | "uncertain";

/**
 * Whether a relationship's endpoint types are permitted by the catalog (S34).
 *
 * `null` in the database means "not evaluated", which is NOT the same answer as
 * `indeterminate` (evaluated, but an endpoint's type is unknown).
 */
export type CompatibilityState = "compatible" | "conflict" | "indeterminate";

/** What an evidence row or a classification log row is about. */
export type CandidateKind = "entity" | "relationship";

/**
 * Which fact an evidence row records.
 *
 * - `textual`  the quote was located in the source (before any support judgement).
 * - `semantic` an evaluation that the located text supports the candidate.
 *
 * A quote that exists never guarantees that it supports the extractor's reading.
 */
export type EvidenceKind = "textual" | "semantic";

// ---------------------------------------------------------------------------
// GROUP 1: Stacks
// ---------------------------------------------------------------------------

export const stacks = pgTable(
  "stacks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    description: text("description"),
    scope: text("scope").notNull().default("stack"),
    // Nullable in SQL: default 'incremental' with no NOT NULL.
    compilationStrategy: text("compilation_strategy").default("incremental"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    // Added by a later ALTER TABLE in db/schema.sql, not the CREATE TABLE.
    synthesizeDescriptions: boolean("synthesize_descriptions")
      .notNull()
      .default(false),
    // Added by a later ALTER TABLE in db/schema.sql, not the CREATE TABLE. Nullable
    // and load-bearing: `null` is the ORACLE's behaviour (advertise the default type
    // hints and accept whatever the model emits), which is what every Stack does.
    ontology: jsonb("ontology").$type<JsonObject>(),
    // The versioned per-Stack type catalog, added by the open-classification upgrade.
    // NULL means "no catalog of its own": fall back to the legacy `ontology` column
    // and the documented default catalog.
    typeCatalog: jsonb("type_catalog").$type<JsonObject>(),
    catalogVersion: text("catalog_version"),
  },
  (t) => [
    unique("stacks_domain_key").on(t.domain),
    check("valid_scope", sql`${t.scope} in ('stack', 'workspace', 'domain')`),
    check(
      "valid_strategy",
      sql`${t.compilationStrategy} in ('incremental', 'global')`,
    ),
    check("valid_domain_slug", sql`${t.domain} ~ '^[a-z0-9-]+$'`),
    check(
      "valid_type_catalog_is_object",
      sql`${t.typeCatalog} is null or jsonb_typeof(${t.typeCatalog}) = 'object'`,
    ),
    index("idx_stacks_domain").on(t.domain),
  ],
);

// ---------------------------------------------------------------------------
// GROUP 2: Documents
// ---------------------------------------------------------------------------

export const stackDocuments = pgTable(
  "stack_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentType: text("content_type"),
    sourceHash: text("source_hash").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    originalLength: integer("original_length"),
    audit: jsonb("audit").$type<JsonObject>(),
    ingestedAt: timestamp("ingested_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("unique_hash_per_stack").on(t.stackId, t.sourceHash),
    index("idx_docs_stack").on(t.stackId),
    index("idx_docs_hash").on(t.sourceHash),
  ],
);

// ---------------------------------------------------------------------------
// GROUP 3: Compilation pipeline tables
// ---------------------------------------------------------------------------

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => stackDocuments.id, { onDelete: "cascade" }),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    tokenCount: integer("token_count"),
    // pgvector column. Dimension is fixed by the schema (config.EMBEDDING_DIM).
    embedding: vector("embedding", { dimensions: 768 }),
    chunkerStrategy: text("chunker_strategy").default("sentence"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("unique_chunk_per_doc").on(t.documentId, t.chunkIndex),
    index("idx_chunks_stack").on(t.stackId),
  ],
);

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
    index("idx_entities_stack").on(t.stackId),
    index("idx_entities_type").on(t.type),
    index("idx_entities_stack_name").on(t.stackId, t.name),
  ],
);

export const ontologyRelationships = pgTable(
  "ontology_relationships",
  {
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
  },
  (t) => [
    // KEPT as well as the identity-key constraint: two consolidators infer their upsert
    // target from `on conflict (stack_id, from_entity_id, to_entity_id, type)`, and
    // dropping the constraint that backs those columns breaks every re-ingest.
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
    index("idx_rels_stack").on(t.stackId),
    index("idx_rels_from").on(t.fromEntityId),
    index("idx_rels_to").on(t.toEntityId),
  ],
);

export const entitySourceDocuments = pgTable(
  "entity_source_documents",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => stackDocuments.id, { onDelete: "cascade" }),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    contributedAt: timestamp("contributed_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Composite primary key; the database names it entity_source_documents_pkey.
    primaryKey({
      name: "entity_source_documents_pkey",
      columns: [t.entityId, t.documentId],
    }),
    index("idx_esd_entity").on(t.entityId),
    index("idx_esd_doc").on(t.documentId),
  ],
);

// ---------------------------------------------------------------------------
// GROUP 5: Entity Pages
// ---------------------------------------------------------------------------

export const entityPages = pgTable(
  "entity_pages",
  {
    entityId: uuid("entity_id")
      .primaryKey()
      .references(() => ontologyEntities.id, { onDelete: "cascade" }),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    entityName: text("entity_name").notNull(),
    markdown: text("markdown").notNull(),
    graphVersion: text("graph_version").notNull(),
    sourceType: text("source_type").notNull().default("compiled"),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    generatedByModel: text("generated_by_model"),
  },
  (t) => [index("idx_pages_stack").on(t.stackId)],
);

// ---------------------------------------------------------------------------
// GROUP 6: Backfeed Queue
// ---------------------------------------------------------------------------

export const backfeedQueue = pgTable(
  "backfeed_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    triggerType: text("trigger_type").notNull().default("manual"),
    proposal: jsonb("proposal").$type<BackfeedProposal>().notNull(),
    note: text("note"),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("valid_origin", sql`${t.origin} in ('run', 'direct')`),
    check(
      "valid_trigger_type",
      sql`${t.triggerType} in ('manual', 'auto', 'api')`,
    ),
    check("valid_status", sql`${t.status} in ('pending', 'approved', 'rejected')`),
    index("idx_backfeed_stack").on(t.stackId),
    index("idx_backfeed_status").on(t.status),
    index("idx_backfeed_created").on(t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// GROUP 7: Open classification (evidence and history)
// ---------------------------------------------------------------------------

/**
 * Per-candidate provenance: one row per (candidate, source span).
 *
 * A candidate is judged BEFORE it has a UUID, so `candidateRef` is the run-scoped
 * identifier the pipeline assigned and not a foreign key; `identity_key` on the
 * entity/relationship is what reconnects it after consolidation.
 */
export const kgEvidence = pgTable(
  "kg_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    candidateKind: text("candidate_kind").$type<CandidateKind>().notNull(),
    candidateRef: text("candidate_ref").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => stackDocuments.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").references(() => documentChunks.id, {
      onDelete: "cascade",
    }),
    chunkIndex: integer("chunk_index"),
    evidenceText: text("evidence_text").notNull(),
    // Character offsets into `document_chunks.content`, never into the original file.
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    normalizedMatch: boolean("normalized_match").notNull().default(false),
    evidenceKind: text("evidence_kind").$type<EvidenceKind>().notNull().default("textual"),
    model: text("model"),
    pipelineVersion: text("pipeline_version"),
    catalogVersion: text("catalog_version"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "valid_evidence_candidate_kind",
      sql`${t.candidateKind} in ('entity', 'relationship')`,
    ),
    check(
      "valid_evidence_kind",
      sql`${t.evidenceKind} in ('textual', 'semantic')`,
    ),
    check(
      "valid_evidence_offsets",
      sql`(${t.charStart} is null and ${t.charEnd} is null)
        or (${t.charStart} is not null and ${t.charEnd} is not null
            and ${t.charStart} >= 0 and ${t.charEnd} > ${t.charStart})`,
    ),
    index("idx_evidence_candidate").on(t.stackId, t.candidateKind, t.candidateRef),
    index("idx_evidence_document").on(t.documentId),
    index("idx_evidence_chunk").on(t.chunkId),
  ],
);

/**
 * Append-only classification history: what the row was, what it became, and why.
 *
 * The JEV columns repeat here on purpose; reading the current row would only ever
 * show the LATEST answer, which cannot audit a reclassification.
 */
export const kgClassificationLog = pgTable(
  "kg_classification_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    candidateKind: text("candidate_kind").$type<CandidateKind>().notNull(),
    candidateRef: text("candidate_ref").notNull(),
    previousState: text("previous_state").$type<ClassificationState>(),
    newState: text("new_state").$type<ClassificationState>().notNull(),
    previousCanonicalType: text("previous_canonical_type"),
    newCanonicalType: text("new_canonical_type"),
    jevChoice: text("jev_choice"),
    jevConfidence: real("jev_confidence"),
    jevTopProbability: real("jev_top_probability"),
    jevModel: text("jev_model"),
    catalogVersion: text("catalog_version"),
    classifierVersion: text("classifier_version"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "valid_log_candidate_kind",
      sql`${t.candidateKind} in ('entity', 'relationship')`,
    ),
    check(
      "valid_log_new_state",
      sql`${t.newState} in ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed')`,
    ),
    check(
      "valid_log_previous_state",
      sql`${t.previousState} is null or ${t.previousState} in ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed')`,
    ),
    index("idx_classification_log_candidate").on(
      t.stackId,
      t.candidateKind,
      t.candidateRef,
      t.createdAt.desc(),
    ),
  ],
);

/**
 * Indexes that Drizzle ORM cannot express, kept as raw SQL.
 *
 * `document_chunks` has two index families that are not part of Drizzle's
 * pg-core index builder surface because they need access methods (`hnsw`,
 * `gin`) and operator classes (`vector_cosine_ops`, `gin_trgm_ops`) that the
 * builder has no API for:
 *
 *   1. HNSW cosine-similarity index over the embedding vector.
 *   2. pg_trgm GIN index over chunk content, for hybrid retrieval scoring.
 *
 * They are created by `db/schema.sql` and are NOT created by this module. This
 * export exists so the omission is visible and explicit rather than silent, and
 * so a future migration tool can apply them verbatim if the schema is ever
 * rebuilt from Drizzle instead of the SQL file.
 */
export const UNEXPRESSED_INDEXES_SQL = [
  `create index if not exists idx_chunks_embedding on document_chunks using hnsw (embedding vector_cosine_ops);`,
  `create index if not exists idx_chunks_content_trgm on document_chunks using gin (content gin_trgm_ops);`,
] as const;

/** Extensions the schema depends on; also raw SQL, also already applied. */
export const REQUIRED_EXTENSIONS_SQL = [
  `create extension if not exists vector;`,
  `create extension if not exists pg_trgm;`,
  `create extension if not exists pgcrypto;`,
] as const;
