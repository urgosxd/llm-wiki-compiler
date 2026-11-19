import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// Value imports, not a re-export alone: `entity_source_documents` and `entity_pages` below
// carry a foreign key to `ontology_entities`, and every Stack-keyed table below carries one to
// `stacks`. Both bindings must be in scope for those thunks, and this is the only direction in
// which the two modules may import each other by VALUE — see the note below.
import { ontologyEntities, stacks } from "./schema-kg-ontology.js";

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
 *
 * ## Three tables are re-exported rather than declared here
 *
 * `stacks`, `ontology_entities` and `ontology_relationships` are declared in
 * `schema-kg-ontology.ts` and re-exported at the end of this module's type surface,
 * so a caller still imports the whole mirror from here — including under the
 * namespace form `import * as schema from "./schema.js"`.
 *
 * ## The value edge between the two modules runs one way
 *
 * This module imports `stacks` and `ontology_entities` from `schema-kg-ontology.ts`
 * by value; `schema-kg-ontology.ts` imports nothing from here but TYPES, which
 * `verbatimModuleSyntax` erases. That is the same direction `schema-open-classification.ts`
 * documents, and it is a hard requirement rather than a preference: `stacks` is the foreign-key
 * target of both ontology tables, so it cannot live on the far side of the edge without
 * recreating a value-level cycle. See that module for where the anchor sits and why.
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
 * The open-classification state types live with the tables that use them, in
 * `schema-open-classification.ts`. They are re-exported here — as TYPES only, which
 * `verbatimModuleSyntax` erases — so a caller that imports the mirror as a namespace
 * still sees one module surface.
 *
 * See that file for the meaning of each state. The short version: `null` means "no
 * decision was recorded", `classified` means a catalog type was assigned, and every
 * `free_*` value means the row is real knowledge that simply fits no catalog type.
 */
export type {
  CandidateKind,
  ClassificationState,
  CompatibilityState,
  EvidenceKind,
  SupportState,
} from "./schema-open-classification.js";

/**
 * The two ontology classes a row can carry.
 *
 * Deliberately separate from `ClassificationState`: that vocabulary answers "did a catalog
 * match this label" and is rewritten by the classifier, while this one answers "did the
 * ontology accept this claim" and must survive every later classification pass.
 *
 * Declared here rather than beside the columns that use it, because a type is erased at compile
 * time: `schema-kg-ontology.ts` can import it from this module without adding a value-level edge
 * in the direction that would close a cycle. Every caller keeps importing it from the mirror it
 * already imports it from.
 */
export type OntologyVerdict = "accepted" | "rejected";

/**
 * `stacks` and the two knowledge-graph tables live in `schema-kg-ontology.ts`: that is where the
 * ontology verdict columns that pushed this file past its 400-line cap were added, and `stacks`
 * is the foreign-key target those tables carry, so it has to sit on the referenced side of the
 * one-way value edge. All three are re-exported here so the mirror keeps ONE module surface and
 * every existing import path — including the namespace form `import * as schema from
 * "./schema.js"` — resolves unchanged.
 *
 * See that module for why the anchor table sits there and what would reintroduce a cycle.
 */
export {
  ontologyEntities,
  ontologyRelationships,
  stacks,
} from "./schema-kg-ontology.js";

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
