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
import type { CatalogMismatch } from "../../core/open-admission.js";
import type { TripletTruncation } from "../../core/graph-prompt.js";

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
 * The `jsonb` key the open-contract section lives under.
 *
 * A third sibling, because it answers a third question: `ontology` answers "what
 * did the declaration turn away" (nothing, now that it orients instead of
 * filtering), `extraction` answers "did the extraction answer at all", and this
 * one answers "what did the run KEEP although the catalog does not name it, what
 * did it refuse for being structurally incomplete, and what did a per-chunk budget
 * cap" (S7, S9).
 */
export const OPEN_AUDIT_KEY = "open";

/**
 * The `jsonb` key the classification section lives under.
 *
 * Present only when a classifier actually ran, because that is the only case in
 * which it has anything true to say. A run with no credential writes no section at
 * all: its candidates keep the state `pending` on their own rows, which is the
 * observable fact, and a section of zeros would claim an evaluation nobody
 * performed.
 */
export const CLASSIFICATION_AUDIT_KEY = "classification";

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

/** One kept proposal the catalog does not name, as it appears in the blob. */
export const CatalogMismatchSampleSchema = z.object({
  /** `entity_type` or `predicate`. */
  kind: z.string(),
  /** The entity name, or `subject -> object` for a predicate. */
  of: z.string(),
  /** What the extractor proposed, verbatim. */
  proposed: z.string(),
});

/** One per-chunk budget that dropped something. */
export const TruncationSampleSchema = z.object({
  chunk_index: z.number().int().nullable(),
  limit: z.number().int().nonnegative(),
  considered: z.number().int().nonnegative(),
  dropped: z.number().int().positive(),
});

/**
 * The open-contract section, as stored.
 *
 * `outside_catalog` counts KEPT proposals, not losses: every one of them is a row
 * in the graph. It is written so an operator can see that a document was read
 * under a catalog that does not describe it — the fact a silent drop used to hide.
 * `structural` counts the only refusals an open run makes (a triplet with no
 * endpoint or no predicate), and `truncations` names each cap that dropped a
 * candidate rather than letting a bounded answer look complete (S9).
 *
 * The section is absent when all three are empty, exactly like the extraction one,
 * so a run that stayed inside its vocabulary writes the byte-identical blob it
 * wrote before this section existed.
 */
export const OpenAuditSchema = z.object({
  outside_catalog: z.number().int().nonnegative(),
  /** Distinct kinds of mismatch, sorted, so two identical runs produce one blob. */
  kinds: z.array(z.string()),
  samples: z.array(CatalogMismatchSampleSchema),
  structural: z.number().int().nonnegative(),
  truncations: z.array(TruncationSampleSchema),
});

/** A validated open-contract report. */
export type OpenAudit = z.infer<typeof OpenAuditSchema>;

/**
 * How many decisions landed in each state.
 *
 * The five states are a CLOSED set, spelled out rather than left as a free-form
 * record, so a sixth state cannot appear in a stored blob before the schema's CHECK
 * constraint and this schema agree on it. Every key is optional and absent keys are
 * simply not written, matching the module's absent-when-empty rule.
 */
export const ClassificationStateCountsSchema = z.object({
  classified: z.number().int().nonnegative().optional(),
  free_no_match: z.number().int().nonnegative().optional(),
  free_uncertain: z.number().int().nonnegative().optional(),
  pending: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
});

/**
 * The classification section, as stored.
 *
 * It records the four magnitudes S23 keeps apart, each where it belongs: the STATE
 * counts here, the raw vendor probabilities on the rows and in the classification
 * log, the catalog and classifier versions beside them, and nothing about human
 * verification at all.
 *
 * ## The section is ALWAYS written, in two shapes
 *
 * An absent section used to mean "no classifier ran", which is indistinguishable
 * from a document written by a build that never wrote one — and the consequence of
 * running without a credential is not nothing. So `configured` is an explicit
 * boolean in both directions, and the unconfigured shape carries what an operator
 * has to know: why it matters, and, when candidates were actually left undecided, a
 * structured warning naming the filter they disappear from.
 *
 * The nine-key ingest response stays untouched: it is oracle-parity pinned, so this
 * `jsonb` column is the only place this can travel.
 */
export const ConfiguredClassificationAuditSchema = z.object({
  configured: z.literal(true),
  states: ClassificationStateCountsSchema,
  /** The vendor model id the requests asked for. */
  model: z.string(),
  /** The endpoint the requests were sent to, credential redacted. */
  base_url: z.string(),
  catalog_version: z.string(),
  classifier_version: z.string(),
});

/** One structured warning: a stable code a consumer can branch on, and its text. */
export const ClassificationWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

/** The section written when NO classifier is configured. */
export const UnconfiguredClassificationAuditSchema = z.object({
  configured: z.literal(false),
  /** Why the unconfigured state matters, naming the query parameter it costs. */
  consequence: z.string(),
  /** Present only when this run actually left candidates undecided. */
  warnings: z.array(ClassificationWarningSchema).optional(),
});

/** The classification section, discriminated by whether a classifier was available. */
export const ClassificationAuditSchema = z.discriminatedUnion("configured", [
  ConfiguredClassificationAuditSchema,
  UnconfiguredClassificationAuditSchema,
]);

/** A validated classification report, in either shape. */
export type ClassificationAudit = z.infer<typeof ClassificationAuditSchema>;

/** The configured shape, which is what a run that classified writes. */
export type ConfiguredClassificationAudit = z.infer<typeof ConfiguredClassificationAuditSchema>;

/** The unconfigured shape, which is what a run with no credential writes. */
export type UnconfiguredClassificationAudit = z.infer<typeof UnconfiguredClassificationAuditSchema>;

/**
 * What an unconfigured classifier costs, spelled once.
 *
 * This is the `consequence` the audit publishes, and it is a runtime-observable
 * fact rather than a documentation claim: a deployment with no credential answers a
 * canonical `?type=` filter with nothing for everything it ingests, because a filter
 * returns only CLASSIFIED matches and every candidate stays `pending`.
 */
export const CLASSIFICATION_DISABLED_CONSEQUENCE =
  "No classifier is configured (TYPESAFE_API_KEY is unset or blank), so this run made " +
  "no outbound decision call and classified nothing. Every candidate it kept remains " +
  "in the operational state 'pending', and a canonical ?type= filter returns only " +
  "classified matches, so none of them is reachable through ?type= until a credential " +
  "is configured and the Stack is reclassified.";

/** The stable code of the warning an unconfigured run with undecided candidates emits. */
export const UNCLASSIFIED_WARNING_CODE = "classification_unconfigured_candidates_unclassified";

/**
 * The warning text for `count` candidates left undecided by an unconfigured run.
 *
 * The count is in the message because a warning without one reads like a caveat
 * rather than like a measurement of this run.
 *
 * @param count - How many candidates this run left unclassified.
 * @returns The warning message, naming the query parameter they disappear from.
 */
export function unclassifiedWarningMessage(count: number): string {
  return (
    `${String(count)} candidate(s) from this run were left unclassified because no classifier ` +
    "is configured; only classified rows match a canonical ?type= filter, so these facts " +
    "stay out of every ?type= query until classification runs."
  );
}

/** The state counts of one run, as the schema declares them. */
export type ClassificationStateCounts = z.infer<typeof ClassificationStateCountsSchema>;

/** What a classification report is built from. */
export interface ClassificationAuditInput {
  readonly states: ClassificationStateCounts;
  /** The vendor model id the requests asked for. */
  readonly model: string;
  /** The endpoint they were sent to, already credential-redacted by the runtime. */
  readonly baseUrl: string;
  readonly catalogVersion: string;
  readonly classifierVersion: string;
}

/**
 * Builds the classification section for a run where a classifier actually ran.
 *
 * @param input - State counts, the endpoint, and the versions that produced them.
 * @returns The validated section.
 */
export function buildClassificationAudit(input: ClassificationAuditInput): ConfiguredClassificationAudit {
  return ConfiguredClassificationAuditSchema.parse({
    configured: true,
    states: input.states,
    model: input.model,
    base_url: input.baseUrl,
    catalog_version: input.catalogVersion,
    classifier_version: input.classifierVersion,
  });
}

/** What an unconfigured run has to report about itself. */
export interface UnconfiguredClassificationInput {
  /** How many candidates this run kept, all of which stay unclassified. */
  readonly candidateCount: number;
}

/**
 * Builds the classification section for a run with no classifier configured.
 *
 * The `warnings` entry appears only when the run actually kept candidates: a
 * document that produced nothing has nothing to warn about, and a warning on every
 * empty ingest would train a reader to ignore it. The `consequence` is always
 * present, because it is a property of the deployment rather than of this document.
 *
 * @param input - How many candidates were left undecided.
 * @returns The validated section.
 */
export function buildUnconfiguredClassificationAudit(
  input: UnconfiguredClassificationInput,
): UnconfiguredClassificationAudit {
  const warning = {
    code: UNCLASSIFIED_WARNING_CODE,
    message: unclassifiedWarningMessage(input.candidateCount),
  };
  return UnconfiguredClassificationAuditSchema.parse({
    configured: false,
    consequence: CLASSIFICATION_DISABLED_CONSEQUENCE,
    ...(input.candidateCount <= 0 ? {} : { warnings: [warning] }),
  });
}

/** What one open extraction run kept outside the catalog, and what it capped. */
export interface OpenExtractionFacts {
  readonly outsideCatalog?: readonly CatalogMismatch[] | undefined;
  readonly structuralRejections?: readonly unknown[] | undefined;
  readonly truncations?: readonly TripletTruncation[] | undefined;
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
  /** Absent when the run kept nothing outside the catalog and capped nothing. */
  readonly open?: OpenAudit;
  /**
   * Always present on a run of this pipeline: `configured: true` when a classifier
   * answered, `configured: false` with the consequence when none was available.
   */
  readonly classification?: ClassificationAudit;
}

/**
 * Builds the open-contract section, or nothing when there is nothing to report.
 *
 * Returning `undefined` rather than an object of zeros keeps a healthy ingest's
 * stored blob byte-identical to the one written before this section existed.
 *
 * @param facts - What the open run kept, refused and capped.
 * @returns The validated section, or `undefined` when all three are empty.
 */
export function buildOpenAudit(facts: OpenExtractionFacts): OpenAudit | undefined {
  const outsideCatalog = facts.outsideCatalog ?? [];
  const structural = facts.structuralRejections?.length ?? 0;
  const truncations = facts.truncations ?? [];
  if (outsideCatalog.length === 0 && structural === 0 && truncations.length === 0) {
    return undefined;
  }
  return OpenAuditSchema.parse({
    outside_catalog: outsideCatalog.length,
    kinds: [...new Set(outsideCatalog.map((mismatch) => mismatch.kind))].sort(),
    samples: outsideCatalog.slice(0, MAX_AUDIT_SAMPLES).map((mismatch) => ({
      kind: mismatch.kind,
      of: truncateName(mismatch.of),
      proposed: truncateName(mismatch.proposed),
    })),
    structural,
    truncations: truncations.map((truncation) => ({
      chunk_index: truncation.chunkIndex,
      limit: truncation.limit,
      considered: truncation.considered,
      dropped: truncation.dropped,
    })),
  });
}

/**
 * Writes the ingest's sections onto the document row, preserving other keys.
 *
 * The stored column is merged rather than replaced, because a later audit producer
 * must not be able to erase this one by writing its own section: every section this
 * writer owns is removed from the existing blob and then re-added from this run, so
 * an ABSENT section disappears (`- key`) instead of surviving as a stale report,
 * and a sibling key it does not own (`quality`, today) is untouched.
 *
 * Each section REPLACES its key on a re-ingest, which is deliberate: the report
 * describes the run that produced the current graph, and a stale report from a
 * previous run would describe a graph that no longer exists.
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
  // A null binds SQL NULL, which is what makes the CASE below drop the key. A
  // `{}` placeholder would instead store an empty object as a present section.
  const extractionJson = report.extraction === undefined ? null : JSON.stringify(report.extraction);
  const openJson = report.open === undefined ? null : JSON.stringify(report.open);
  const classificationJson =
    report.classification === undefined ? null : JSON.stringify(report.classification);
  await tx.execute(sql`
    update stack_documents
    set audit = (coalesce(audit, '{}'::jsonb)
          - ${EXTRACTION_AUDIT_KEY}::text
          - ${OPEN_AUDIT_KEY}::text
          - ${CLASSIFICATION_AUDIT_KEY}::text)
      || jsonb_build_object(${ONTOLOGY_AUDIT_KEY}::text, ${JSON.stringify(report.ontology)}::text::jsonb)
      || case
           when ${extractionJson}::text is null then '{}'::jsonb
           else jsonb_build_object(${EXTRACTION_AUDIT_KEY}::text, ${extractionJson}::text::jsonb)
         end
      || case
           when ${openJson}::text is null then '{}'::jsonb
           else jsonb_build_object(${OPEN_AUDIT_KEY}::text, ${openJson}::text::jsonb)
         end
      || case
           when ${classificationJson}::text is null then '{}'::jsonb
           else jsonb_build_object(${CLASSIFICATION_AUDIT_KEY}::text, ${classificationJson}::text::jsonb)
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
 * Reads the open-contract section back out of a stored `audit` value.
 *
 * @param audit - The raw `stack_documents.audit` value.
 * @returns The parsed section, or `undefined` when the run stayed inside its catalog.
 * @throws {z.ZodError} When the stored section exists but does not match the schema.
 */
export function readOpenAudit(audit: unknown): OpenAudit | undefined {
  const section = sectionOf(audit, OPEN_AUDIT_KEY);
  return section === undefined ? undefined : OpenAuditSchema.parse(section);
}

/**
 * Reads the classification section back out of a stored `audit` value.
 *
 * The union is resolved by the `configured` discriminator, so a consumer cannot read
 * an unconfigured run's section as if it carried state counts, or the reverse.
 *
 * @param audit - The raw `stack_documents.audit` value.
 * @returns The parsed section, or `undefined` for a document written before this
 *   section existed.
 * @throws {z.ZodError} When the stored section matches neither shape.
 */
export function readClassificationAudit(audit: unknown): ClassificationAudit | undefined {
  const section = sectionOf(audit, CLASSIFICATION_AUDIT_KEY);
  return section === undefined ? undefined : ClassificationAuditSchema.parse(section);
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
