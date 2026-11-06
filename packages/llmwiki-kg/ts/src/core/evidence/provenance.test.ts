/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/provenance.test.ts
 * @description The provenance record a candidate span becomes in `kg_evidence`.
 *
 * WHY THIS FILE EXISTS. S10 asks every candidate to keep its document, its chunk,
 * its quote, verifiable offsets, the model and the pipeline version. Those values
 * are not free-form: `kg_evidence` constrains the offsets (`char_start >= 0`,
 * `char_end > char_start`, both null or both set) and restricts `evidence_kind`
 * to `textual`/`semantic`. A record that satisfied the type but not the
 * constraint would only fail later, inside a database transaction, so this file
 * checks the produced values against exactly those two rules.
 */

import { describe, expect, it } from "vitest";

import { assessQuote, withSupport } from "./assessment.js";
import { locateQuote } from "./locate.js";
import { evidenceProvenance } from "./provenance.js";
import { EvidenceStageError } from "./types.js";

/** A one-sentence chunk and the quote that appears in it verbatim. */
const CHUNK = "The policy governs the change process.";

/** Every provenance field the caller owns, outside the locating step. */
const PROVENANCE = {
  candidateKind: "relationship" as const,
  candidateRef: "run-7:relationship:1",
  documentId: "0c9d5f7e-0000-4000-8000-000000000001",
  chunkId: "0c9d5f7e-0000-4000-8000-000000000002",
  chunkIndex: 3,
  evidenceText: CHUNK,
  model: "gpt-4.1-mini",
  pipelineVersion: "kg-pipeline-2024.06",
  catalogVersion: "catalog-1.0.0",
} as const;

describe("evidenceProvenance", () => {
  it("records verifiable offsets for a located quote", () => {
    const row = evidenceProvenance({
      ...PROVENANCE,
      assessment: assessQuote(locateQuote(CHUNK, CHUNK)),
    });
    expect(row.match).toBe("exact");
    expect(row.normalizedMatch).toBe(false);
    expect(row.evidenceKind).toBe("textual");
    expect(row.charStart).toBe(0);
    if (row.charStart === null || row.charEnd === null) {
      throw new Error("expected verifiable offsets for a located quote");
    }
    expect(row.charStart).toBeGreaterThanOrEqual(0);
    expect(row.charEnd).toBeGreaterThan(row.charStart);
  });

  it("flags a normalized match and keeps the caller's provenance", () => {
    const chunk = "El sistema — soporta el proceso.";
    const row = evidenceProvenance({
      ...PROVENANCE,
      assessment: assessQuote(locateQuote("el sistema - soporta el proceso.", chunk)),
    });
    expect(row.match).toBe("normalized");
    expect(row.normalizedMatch).toBe(true);
    expect(row.candidateKind).toBe("relationship");
    expect(row.candidateRef).toBe(PROVENANCE.candidateRef);
    expect(row.documentId).toBe(PROVENANCE.documentId);
    expect(row.chunkId).toBe(PROVENANCE.chunkId);
    expect(row.chunkIndex).toBe(3);
    expect(row.model).toBe(PROVENANCE.model);
    expect(row.pipelineVersion).toBe(PROVENANCE.pipelineVersion);
    expect(row.catalogVersion).toBe(PROVENANCE.catalogVersion);
  });

  it("records an absent quote as null offsets instead of dropping it", () => {
    const row = evidenceProvenance({
      ...PROVENANCE,
      evidenceText: "The policy invalidates the process.",
      assessment: assessQuote(locateQuote("The policy invalidates the process.", CHUNK)),
    });
    expect(row.charStart).toBeNull();
    expect(row.charEnd).toBeNull();
    expect(row.normalizedMatch).toBe(false);
    expect(row.evidenceText).toBe("The policy invalidates the process.");
  });

  it("marks a judged quote as semantic evidence", () => {
    const row = evidenceProvenance({
      ...PROVENANCE,
      assessment: withSupport(assessQuote(locateQuote(CHUNK, CHUNK)), {
        verdict: "supported",
        assessedBy: "jev-double",
        rationale: null,
      }),
    });
    expect(row.evidenceKind).toBe("semantic");
  });

  it("refuses an offset span that violates the stored constraint", () => {
    const inverted = {
      quote: { status: "found" as const, span: { charStart: 5, charEnd: 5, match: "exact" as const } },
      support: null,
    };
    expect(() => evidenceProvenance({ ...PROVENANCE, assessment: inverted })).toThrow(
      EvidenceStageError,
    );
  });
});
