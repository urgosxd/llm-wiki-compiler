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
 * So each section has a name, a schema, and a single accessor. Two concrete
 * hazards this closes:
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
 *
 * ## A second section, for a different question
 *
 * `extraction` sits beside `ontology` and holds the degradation counters the
 * extraction run produced: `mangledChunks` and `schemaViolations`. They are not
 * ontology facts — a mangled chunk produces no triplet for the declaration to
 * judge — and they cannot ride the response, because `IngestionResult` is nine
 * fixed keys byte-identical to the oracle. This column is therefore the only
 * place an API consumer can read them, which is why they are written here and
 * why they are optional: absent means the ingest did not degrade.
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
 * The `jsonb` key the extraction-degradation section lives under.
 *
 * A sibling of {@link ONTOLOGY_AUDIT_KEY} rather than fields inside it: the
 * ontology section answers "what did the declaration turn away", while this one
 * answers "did the extraction answer at all". One column, two questions, one
 * key each — the same rule that keeps a `jsonb` field from becoming soup.
 */
export const EXTRACTION_AUDIT_KEY = "extraction";

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

/**
 * The extraction-degradation section, as stored.
 *
 * ## Why absence, and not zero, is the healthy signal
 *
 * Both fields are optional and neither is written when it counted nothing, which
 * is exactly how `ExtractionResult.failedChunks`, `mangledChunks` and
 * `schemaViolations` already report the same facts one layer down. A healthy
 * ingest therefore writes the byte-identical blob it wrote before this section
 * existed, and a consumer reads "no extraction section" as "nothing degraded"
 * instead of having to tell a zero somebody chose to write from a zero nobody
 * wrote at all.
 *
 * ## The two counters do not share a denominator
 *
 * They must never be summed, divided, or read as shares of one another.
 * `mangledChunks` counts CHUNKS: one per response whose envelope — neither a
 * `triplets` nor an `entities` array — was unusable. `schemaViolations` counts
 * TYPE POSITIONS: a subject's, a relation's, or an object's `type`, so one
 * triplet can contribute up to three and one chunk can contribute many. A
 * consumer that treats them as one population compares chunks to positions.
 */
export const ExtractionAuditSchema = z.object({
  /** Chunks that answered with no usable envelope. Absent when none did. */
  mangledChunks: z.number().int().positive().optional(),
  /** `type` positions outside the schema's `enum`s. Absent when none were. */
  schemaViolations: z.number().int().positive().optional(),
});

/** A validated extraction-degradation report. */
export type ExtractionAudit = z.infer<typeof ExtractionAuditSchema>;

/** The degradation counters one extraction run can report; both are optional. */
export interface ExtractionDegradation {
  readonly mangledChunks?: number;
  readonly schemaViolations?: number;
}

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
 * A counter as it is stored: the number when it counted something, else nothing.
 *
 * `ExtractionResult` already omits a zero, so this is the second of the two
 * places the absent-when-zero rule is enforced — and the one that survives a
 * caller handing over an explicit `0`.
 *
 * @param value - The run's count, or `undefined` when the run never counted.
 * @returns The count when positive, otherwise `undefined`.
 */
function counted(value: number | undefined): number | undefined {
  return value === undefined || value <= 0 ? undefined : value;
}

/**
 * Builds the degradation section, or nothing when the run did not degrade.
 *
 * Returning `undefined` rather than an object of zeros is what keeps a healthy
 * ingest's stored blob byte-identical to the one written before this section
 * existed. The two counters are forwarded independently: one can fire without
 * the other, and coalescing them would answer neither question.
 *
 * @param degradation - The counters from one extraction run.
 * @returns The validated section, or `undefined` when every counter is zero.
 */
export function buildExtractionAudit(
  degradation: ExtractionDegradation,
): ExtractionAudit | undefined {
  const mangledChunks = counted(degradation.mangledChunks);
  const schemaViolations = counted(degradation.schemaViolations);
  if (mangledChunks === undefined && schemaViolations === undefined) {
    return undefined;
  }
  return ExtractionAuditSchema.parse({
    ...(mangledChunks === undefined ? {} : { mangledChunks }),
    ...(schemaViolations === undefined ? {} : { schemaViolations }),
  });
}

/** Everything one ingest writes into `stack_documents.audit`. */
export interface IngestAuditReport {
  readonly ontology: OntologyAudit;
  /** Absent on a healthy extraction, which leaves the stored blob unchanged. */
  readonly extraction?: ExtractionAudit;
}

/**
 * Writes the ingest's sections onto the document row, preserving other keys.
 *
 * `jsonb_set` with `create_missing = true` merges into whatever is already there
 * rather than replacing the column, because a later audit producer must not be
 * able to erase this one by writing its own section. Each section REPLACES its
 * key on a re-ingest, which is deliberate: the report describes the run that
 * produced the current graph, and a stale report from a previous run would
 * describe a graph that no longer exists.
 *
 * For the same reason an ABSENT extraction section DELETES the stored one
 * (`jsonb - key`) instead of preserving it. Without that, a document that
 * degraded once and later ingested cleanly would keep reporting the first run's
 * counters forever, and the degradation section would describe a graph it no
 * longer matches — the exact staleness the replace rule exists to prevent.
 *
 * @param tx - The ingest transaction.
 * @param docId - Document the audit describes.
 * @param report - The validated sections this run produced.
 */
export async function writeIngestAudit(
  tx: Database,
  docId: string,
  report: IngestAuditReport,
): Promise<void> {
  const ontologyJson = JSON.stringify(report.ontology);
  const extraction = report.extraction;
  // The CASE evaluates one branch, but both must still PARSE: a bound
  // `undefined` is dropped from the statement, which leaves the other branch
  // with a dangling `::jsonb` cast and fails the whole update. So the absent
  // case still binds a valid placeholder, and the flag below is what decides
  // whether it is ever written.
  const extractionJson = extraction === undefined ? "{}" : JSON.stringify(extraction);
  // Spelled here, once, so a typo cannot create a sibling key that the reader
  // never finds — the hazard this module exists to close.
  const ontologyPath = `{${ONTOLOGY_AUDIT_KEY}}`;
  const extractionPath = `{${EXTRACTION_AUDIT_KEY}}`;
  await tx.execute(sql`
    update stack_documents
    set audit = case
      when ${extraction === undefined} then
        jsonb_set(
          coalesce(audit, '{}'::jsonb),
          ${ontologyPath},
          ${ontologyJson}::jsonb,
          true
        ) - ${EXTRACTION_AUDIT_KEY}::text
      else
        jsonb_set(
          jsonb_set(
            coalesce(audit, '{}'::jsonb),
            ${ontologyPath},
            ${ontologyJson}::jsonb,
            true
          ),
          ${extractionPath},
          ${extractionJson}::jsonb,
          true
        )
    end
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
  const section = sectionOf(audit, ONTOLOGY_AUDIT_KEY);
  return section === undefined ? undefined : OntologyAuditSchema.parse(section);
}

/**
 * Reads the degradation section back out of a stored `audit` value.
 *
 * @param audit - The raw `stack_documents.audit` value.
 * @returns The parsed section, or `undefined` when no run has degraded — which is
 *   the healthy answer, not a missing one: the section is only ever written after
 *   a counter fired.
 * @throws {z.ZodError} When the stored section exists but does not match the
 *   schema, including a stored `0`, which this section never writes.
 */
export function readExtractionAudit(audit: unknown): ExtractionAudit | undefined {
  const section = sectionOf(audit, EXTRACTION_AUDIT_KEY);
  return section === undefined ? undefined : ExtractionAuditSchema.parse(section);
}

/**
 * One named section of a stored `audit` value, unvalidated.
 *
 * `null`, a non-object, and a missing key all mean "this producer never wrote
 * here", and all three must read the same way. Kept in one place so the two
 * accessors cannot disagree about which blobs count as having a section.
 *
 * @param audit - The raw `stack_documents.audit` value.
 * @param key - The section key to look under.
 * @returns The raw section, or `undefined` when there is none to read.
 */
function sectionOf(audit: unknown, key: string): unknown {
  if (typeof audit !== "object" || audit === null || Array.isArray(audit)) {
    return undefined;
  }
  const section = (audit as Record<string, unknown>)[key];
  return section === undefined || section === null ? undefined : section;
}
