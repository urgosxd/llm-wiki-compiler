/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/audit.test.ts
 * @description The `audit.ontology` section: its schema, its bounds, and the key.
 *
 * WHY THIS FILE EXISTS. `stack_documents.audit` is a `jsonb` column that more than
 * one producer will write to, and its reader used to accept `Record<string,
 * unknown>` and then index into whatever it found. Two hazards follow from that,
 * and every test here pins one of them:
 *
 * 1. A misspelt `jsonb_set` key does not fail — with `create_missing = true` it
 *    creates a SIBLING key, so the writer succeeds and the reader silently finds
 *    nothing. The key is now a single exported constant and the round trip is
 *    tested end to end.
 * 2. A stored section from an older or future shape is accepted and then trusted
 *    field by field. The schema rejects it instead.
 */

import { describe, expect, it } from "vitest";

import type { RejectedTriplet } from "../../core/ontology.js";
import {
  buildExtractionAudit,
  buildOntologyAudit,
  EXTRACTION_AUDIT_KEY,
  ExtractionAuditSchema,
  MAX_AUDIT_SAMPLES,
  MAX_SAMPLE_NAME_LENGTH,
  ONTOLOGY_AUDIT_KEY,
  OntologyAuditSchema,
  readExtractionAudit,
  readOntologyAudit,
} from "./audit.js";

/** One rejected triplet in the shape enforcement produces. */
function rejection(overrides: Partial<RejectedTriplet> = {}): RejectedTriplet {
  return {
    subject: "Globex",
    relation: "PARTNERS_WITH",
    object: "Initech",
    reason: "UNKNOWN_RELATIONSHIP_TYPE",
    offendingType: "PARTNERS_WITH",
    ...overrides,
  };
}

describe("buildOntologyAudit", () => {
  it("reports a clean run as zero rather than omitting the section", () => {
    const audit = buildOntologyAudit(true, []);

    expect(audit).toEqual({
      enforced: true,
      declared: true,
      rejected: 0,
      reason_codes: [],
      samples: [],
    });
  });

  it("keeps the model's emission order rather than sorting the samples", () => {
    // The first rejections are the representative ones. Sorting by name buries
    // them behind whatever happens to start with Z.
    const audit = buildOntologyAudit(true, [
      rejection({ subject: "Zeta" }),
      rejection({ subject: "Alpha" }),
    ]);

    expect(audit.samples.map((sample) => sample.subject)).toEqual(["Zeta", "Alpha"]);
  });

  it("deduplicates and sorts the reason codes so two identical runs match", () => {
    const audit = buildOntologyAudit(true, [
      rejection({ reason: "UNKNOWN_RELATIONSHIP_TYPE" }),
      rejection({ reason: "UNKNOWN_ENTITY_TYPE" }),
      rejection({ reason: "UNKNOWN_RELATIONSHIP_TYPE" }),
    ]);

    expect(audit.reason_codes).toEqual(["UNKNOWN_ENTITY_TYPE", "UNKNOWN_RELATIONSHIP_TYPE"]);
    expect(audit.rejected).toBe(3);
  });

  it("caps the samples while keeping the true rejection count", () => {
    // A many-chunk document can reject hundreds; the column is read on every
    // GET /documents/:id, so a truncated report must still read as truncated.
    const many = Array.from({ length: MAX_AUDIT_SAMPLES + 3 }, (_, index) =>
      rejection({ subject: `Vex ${String(index)}` }),
    );

    const audit = buildOntologyAudit(true, many);

    expect(audit.samples).toHaveLength(MAX_AUDIT_SAMPLES);
    expect(audit.rejected).toBe(MAX_AUDIT_SAMPLES + 3);
  });

  it("elides a name longer than the budget instead of storing it whole", () => {
    const audit = buildOntologyAudit(true, [
      rejection({ subject: "x".repeat(MAX_SAMPLE_NAME_LENGTH + 50) }),
    ]);

    const subject = audit.samples[0]?.subject ?? "";
    expect(subject).toHaveLength(MAX_SAMPLE_NAME_LENGTH + 1);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("leaves a name at exactly the budget untouched", () => {
    const exact = "y".repeat(MAX_SAMPLE_NAME_LENGTH);
    const audit = buildOntologyAudit(true, [rejection({ subject: exact })]);

    expect(audit.samples[0]?.subject).toBe(exact);
  });
});

describe("readOntologyAudit", () => {
  it("finds the section under the exported key and parses it", () => {
    // The round trip that the literal key made unverifiable.
    const written = buildOntologyAudit(true, [rejection()]);

    const read = readOntologyAudit({ [ONTOLOGY_AUDIT_KEY]: written });

    expect(read).toEqual(written);
  });

  it("returns undefined for a document with no audit at all", () => {
    expect(readOntologyAudit(null)).toBeUndefined();
    expect(readOntologyAudit(undefined)).toBeUndefined();
    expect(readOntologyAudit({})).toBeUndefined();
  });

  it("does NOT find a section written under a misspelt key", () => {
    // This is the failure mode the exported constant prevents: the writer would
    // have succeeded and the reader would have found nothing, silently. Pinning
    // the negative shows the two ends really are coupled to one name.
    const written = buildOntologyAudit(true, []);

    expect(readOntologyAudit({ ontolgy: written })).toBeUndefined();
  });

  it("rejects a stored section that does not match the schema", () => {
    // A blob from a future or older producer must not be trusted field by field.
    expect(() => readOntologyAudit({ [ONTOLOGY_AUDIT_KEY]: { rejected: "two" } })).toThrow();
    expect(() => readOntologyAudit({ [ONTOLOGY_AUDIT_KEY]: { enforced: true } })).toThrow();
  });

  it("rejects a negative rejection count", () => {
    expect(
      OntologyAuditSchema.safeParse({
        enforced: true,
        declared: true,
        rejected: -1,
        reason_codes: [],
        samples: [],
      }).success,
    ).toBe(false);
  });

  it("preserves other producers' sections beside it", () => {
    // The column is meant to hold more than one section; reading ours must not
    // depend on ours being the only key.
    const written = buildOntologyAudit(true, []);
    const read = readOntologyAudit({ quality: { passed: true }, [ONTOLOGY_AUDIT_KEY]: written });

    expect(read).toEqual(written);
  });
});

describe("buildExtractionAudit", () => {
  it("writes nothing when the extraction degraded nothing", () => {
    // Absence, not zero, is the healthy signal. This is what keeps a healthy
    // ingest's stored blob byte-identical to the one written before the section
    // existed, and it survives a caller handing over an explicit 0.
    expect(buildExtractionAudit({})).toBeUndefined();
    expect(buildExtractionAudit({ mangledChunks: 0, schemaViolations: 0 })).toBeUndefined();
  });

  it("reports only the counter that fired", () => {
    // One can fire without the other: a mangled chunk produces no triplet, so it
    // cannot also violate the schema, and a violating chunk answered fine.
    expect(buildExtractionAudit({ mangledChunks: 2 })).toEqual({ mangledChunks: 2 });
    expect(buildExtractionAudit({ schemaViolations: 3 })).toEqual({ schemaViolations: 3 });
  });

  it("reports both counters with their own values, never coalesced", () => {
    // They count different units — chunks versus type positions — so one field,
    // a sum, or an average would answer neither question.
    expect(buildExtractionAudit({ mangledChunks: 2, schemaViolations: 5 })).toEqual({
      mangledChunks: 2,
      schemaViolations: 5,
    });
  });

  it("refuses to store a zero, which would read as a counter that fired", () => {
    expect(ExtractionAuditSchema.safeParse({ mangledChunks: 0 }).success).toBe(false);
    expect(ExtractionAuditSchema.safeParse({ schemaViolations: 0 }).success).toBe(false);
  });

  it("leaves the healthy audit blob byte-identical to the pre-section shape", () => {
    // The whole payload, not a field: a healthy ingest must write exactly what it
    // wrote before this slice, so no existing consumer sees a new key.
    const blob = { [ONTOLOGY_AUDIT_KEY]: buildOntologyAudit(true, []) };

    expect(JSON.stringify(blob)).toBe(
      '{"ontology":{"enforced":true,"declared":true,"rejected":0,' +
        '"reason_codes":[],"samples":[]}}',
    );
  });
});

describe("readExtractionAudit", () => {
  it("finds the section under its own key", () => {
    const written = buildExtractionAudit({ mangledChunks: 1 });

    expect(readExtractionAudit({ [EXTRACTION_AUDIT_KEY]: written })).toEqual(written);
  });

  it("returns undefined when no run has degraded", () => {
    // Not an error: the section is only written after a counter fired, so its
    // absence is the healthy answer for every clean document ever ingested.
    expect(readExtractionAudit(null)).toBeUndefined();
    expect(readExtractionAudit({})).toBeUndefined();
    expect(readExtractionAudit({ [ONTOLOGY_AUDIT_KEY]: buildOntologyAudit(true, []) })).toBeUndefined();
  });

  it("does not read the ontology section as the extraction one", () => {
    // One column, two sections: a reader bound to the wrong key must find nothing
    // rather than a section that happens to parse.
    const written = buildExtractionAudit({ schemaViolations: 4 });

    expect(readExtractionAudit({ [ONTOLOGY_AUDIT_KEY]: written })).toBeUndefined();
    expect(readOntologyAudit({ [EXTRACTION_AUDIT_KEY]: written })).toBeUndefined();
  });

  it("rejects a stored section carrying a zero it would never have written", () => {
    expect(() => readExtractionAudit({ [EXTRACTION_AUDIT_KEY]: { mangledChunks: 0 } })).toThrow();
  });
});
