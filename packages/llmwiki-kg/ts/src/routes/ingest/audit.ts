/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/audit.ts
 * @description The `audit` blob's `ontology` section: its shape, its schema, and
 * the one function that writes it.
 *
 * ## Why this is a module and not a few lines inside the pipeline
 *
 * `stack_documents.audit` is a `jsonb` column that more than one thing will write
 * to over time — the ontology report today, a quality report later, and the
 * column's own comment says exactly that (*"so we can put structured audit results
 * here later without a schema change"*). A column with several producers and one
 * consumer sentence is how a `jsonb` field turns into an undocumented soup: every
 * writer invents its own keys and nothing notices.
 *
 * So the section has a name, a schema, and a single accessor. Two concrete hazards
 * this closes:
 *
 * 1. **The key was a string literal** spread into a `jsonb_set` call. A typo there
 *    is silent: `'{ontolgy}'` with `create_missing = true` writes a NEW key beside
 *    the real one, and the reader finds nothing without any error anywhere.
 * 2. **Nothing validated the shape.** The reader took `Record<string, unknown>`, so
 *    a blob written by an older version, or by a future producer using different
 *    keys, is accepted and then trusted field by field.
 *
 * ## Why `null` is a real answer
 *
 * A document ingested before the ontology report existed has `audit = null`, and a
 * document ingested by a caller that never enforced anything has the key present
 * with `rejected: 0`. Those are different facts. The reader returns `undefined`
 * for "no report" and a parsed object otherwise, so a consumer can tell them apart
 * rather than reading a missing report as a clean run.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../../db.js";
import type { RejectedTriplet } from "../../core/ontology.js";

/**
 * The `jsonb` key this section lives under, and the ONLY place it is spelled.
 *
 * `jsonb_set` takes a path array literal, so a misspelt key does not fail — it
 * creates a sibling. Exporting the name keeps the writer and the reader provably
 * on the same key by construction.
 */
export const ONTOLOGY_AUDIT_KEY = "ontology";

/**
 * How many dropped triplets are reported by name.
 *
 * Five is enough to show the shape of a failure — usually one or two distinct
 * causes repeated — without letting a pathological document write thousands of
 * `jsonb` rows into a column read on every `GET /documents/:id`.
 */
export const MAX_AUDIT_SAMPLES = 5;

/** Characters kept from a model-supplied name before it is elided. */
export const MAX_SAMPLE_NAME_LENGTH = 120;

/** One dropped triplet as it appears in the audit blob. */
export const RejectionSampleSchema = z.object({
  subject: z.string(),
  relation: z.string(),
  object: z.string(),
  reason: z.string(),
  /** The type that caused the drop: an entity type or the relation type. */
  offending_type: z.string(),
});

/** The ontology section, as stored. */
export const OntologyAuditSchema = z.object({
  /** Always true now that an undeclared Stack is enforced against the default. */
  enforced: z.boolean(),
  /** Whether the Stack's own declaration was used rather than the default. */
  declared: z.boolean(),
  rejected: z.number().int().nonnegative(),
  /** Distinct reason codes, sorted, so two identical runs produce one blob. */
  reason_codes: z.array(z.string()),
  /** The first few dropped triplets by name; `rejected` is the true total. */
  samples: z.array(RejectionSampleSchema),
});

/** A validated ontology report. */
export type OntologyAudit = z.infer<typeof OntologyAuditSchema>;

/** One dropped triplet, flattened for the blob. */
export type RejectionSample = z.infer<typeof RejectionSampleSchema>;

/** Shortens a model-supplied name to the audit's budget, marking the cut. */
function truncateName(name: string): string {
  return name.length <= MAX_SAMPLE_NAME_LENGTH
    ? name
    : `${name.slice(0, MAX_SAMPLE_NAME_LENGTH)}…`;
}

/** One rejected triplet, flattened and bounded for storage. */
function toRejectionSample(entry: RejectedTriplet): RejectionSample {
  return {
    subject: truncateName(entry.subject),
    relation: truncateName(entry.relation),
    object: truncateName(entry.object),
    reason: entry.reason,
    offending_type: truncateName(entry.offendingType),
  };
}

/**
 * Builds the section for one document.
 *
 * `samples` answers the question `rejected: 2` cannot: *which* triplets went
 * missing, and therefore whether the caller forgot a type or the model invented a
 * relationship. Order is the model's emission order, not sorted: the first
 * rejections are the representative ones.
 *
 * @param declared - Whether the Stack's own declaration was in force.
 * @param rejected - The triplets the ontology turned away.
 * @returns The validated section.
 */
export function buildOntologyAudit(
  declared: boolean,
  rejected: readonly RejectedTriplet[],
): OntologyAudit {
  return OntologyAuditSchema.parse({
    enforced: true,
    declared,
    rejected: rejected.length,
    reason_codes: [...new Set(rejected.map((entry) => entry.reason))].sort(),
    samples: rejected.slice(0, MAX_AUDIT_SAMPLES).map(toRejectionSample),
  });
}

/**
 * Writes the section onto the document row, preserving other producers' keys.
 *
 * `jsonb_set` with `create_missing = true` merges into whatever is already there
 * rather than replacing the column, because a later audit producer must not be
 * able to erase this one by writing its own section. The same call REPLACES this
 * key on a re-ingest, which is deliberate: the report describes the run that
 * produced the current graph, and a stale report from a previous run would
 * describe a graph that no longer exists.
 *
 * @param tx - The ingest transaction.
 * @param docId - Document the audit describes.
 * @param audit - The validated section.
 */
export async function writeOntologyAudit(
  tx: Database,
  docId: string,
  audit: OntologyAudit,
): Promise<void> {
  await tx.execute(sql`
    update stack_documents
    set audit = jsonb_set(
      coalesce(audit, '{}'::jsonb),
      ${`{${ONTOLOGY_AUDIT_KEY}}`},
      ${JSON.stringify(audit)}::jsonb,
      true
    )
    where id = ${docId}
  `);
}

/**
 * Reads the section back out of a stored `audit` value.
 *
 * @param audit - The raw `stack_documents.audit` value: `null` and `undefined`
 *   are both "no audit yet".
 * @returns The parsed section, or `undefined` when this document has no report —
 *   which is different from a report that rejected nothing.
 * @throws {z.ZodError} When the stored section exists but does not match the
 *   schema. Failing loudly beats handing a half-understood blob to a consumer
 *   that will index into whatever it finds.
 */
export function readOntologyAudit(audit: unknown): OntologyAudit | undefined {
  if (typeof audit !== "object" || audit === null || Array.isArray(audit)) {
    return undefined;
  }
  const section = (audit as Record<string, unknown>)[ONTOLOGY_AUDIT_KEY];
  if (section === undefined || section === null) {
    return undefined;
  }
  return OntologyAuditSchema.parse(section);
}
