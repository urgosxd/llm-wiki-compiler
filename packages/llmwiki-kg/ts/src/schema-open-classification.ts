/**
 * @file packages/llmwiki-kg/ts/src/schema-open-classification.ts
 * @description Drizzle mirror of the open-classification part of `db/schema.sql`.
 *
 * ## Why this is not in `schema.ts`
 *
 * `schema.ts` mirrors the tables that existed before the open-classification
 * migration. Adding the two new tables and their state types there pushed it past
 * this repository's 400-line budget, so the split follows the migration boundary:
 * this module is exactly what `db/migration_open_kg_classification.sql` added.
 *
 * ## The dependency direction is one-way, on purpose
 *
 * This module imports `stacks`, `stackDocuments` and `documentChunks` from
 * `schema.ts`; `schema.ts` imports nothing from here except TYPES, which
 * `verbatimModuleSyntax` erases at runtime. A value-level cycle between a table
 * definition module and its extensions is legal ESM but makes module evaluation
 * order load-bearing, and a thunk that ran early would fail with a temporal-dead-zone
 * error instead of a readable one.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { documentChunks, stackDocuments, stacks } from "./schema.js";

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
    check("valid_evidence_kind", sql`${t.evidenceKind} in ('textual', 'semantic')`),
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
