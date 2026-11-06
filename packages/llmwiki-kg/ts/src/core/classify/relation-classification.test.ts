/**
 * @file packages/llmwiki-kg/ts/src/core/classify/relation-classification.test.ts
 * @description Relation classification: the original predicate survives every branch.
 *
 * WHY THIS FILE EXISTS. A relation's verb is the only part of the assertion a
 * classifier can normalize, so it must reach storage exactly as the source stated
 * it — including when a canonical type IS assigned, and especially when none is
 * (S31: "deja sin efecto" is not `related_to`). The second subject here is the
 * identity key (S33): it has to keep two different free predicates between the
 * same two endpoints apart while still letting a later reclassification find the
 * row it must update.
 */

import { describe, expect, it } from "vitest";

import type { RelationCandidate } from "../candidates/types.js";
import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { parseJevConfig } from "../jev/config.js";
import type { JevScriptStep } from "../jev/doubles.js";
import { choiceAnswer, noulAnswer, scriptedJevClient, vendorResponse } from "../jev/doubles.js";
import { RELATION_CLASSIFICATION_QUESTIONS } from "../jev/questions.js";
import { classifyCandidates } from "./batch.js";
import { relationIdentityKey } from "./identity.js";
import type { CandidateEvidence, RelationClassificationDecision } from "./types.js";

const CONFIG = parseJevConfig({});
const CATALOG = defaultTypeCatalog();

/** The evidence the caller already located for a candidate (T3). */
function evidenceFor(...refs: string[]): Record<string, CandidateEvidence> {
  return Object.fromEntries(
    refs.map((ref) => [ref, { quote: "El procedimiento deja sin efecto la política anterior.", context: "…" }]),
  );
}

/** One relation candidate as the extractor emitted it, endpoints already declared. */
function relation(ref: string, predicate: string): RelationCandidate {
  return {
    kind: "relationship",
    ref,
    source: { documentId: "doc-1", chunkId: null, chunkIndex: 0 },
    fromName: "Procedimiento de baja",
    toName: "Política de retención",
    predicate,
    description: null,
  };
}

/** One scripted relation decision: the argmax label, its distribution, and the fit judgement. */
function answer(label: string, probabilities: Record<string, number>, fits: number): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, probabilities, 0.7),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** Classifies the given relation candidates, keeping decision order. */
async function classifyRelations(
  candidates: readonly RelationCandidate[],
  steps: readonly JevScriptStep[],
): Promise<readonly RelationClassificationDecision[]> {
  const batch = await classifyCandidates({
    candidates,
    catalog: CATALOG,
    client: scriptedJevClient(steps),
    config: CONFIG,
    evidence: evidenceFor(...candidates.map((candidate) => candidate.ref)),
  });
  expect(batch.relationDecisions).toHaveLength(candidates.length);
  return batch.relationDecisions;
}

describe("relation classification — a predicate the classifier normalizes (S45.4)", () => {
  it("stores the canonical relation type and keeps the original predicate verbatim", async () => {
    const candidate = relation("relationship:doc-1:0:0", "carries out");
    const [decision] = await classifyRelations(
      [candidate],
      [answer("executes", { executes: 0.8, requires: 0.2 }, 0.93)],
    );
    expect(decision!.classificationState).toBe("classified");
    expect(decision!.canonicalType).toBe("executes");
    expect(decision!.predicate).toBe("carries out");
    expect(decision!.identityKey).toBe("carries out");
  });

  it("keeps a predicate in the document's own language when the label resolves", async () => {
    const candidate = relation("relationship:doc-1:0:0", "lleva a cabo");
    const [decision] = await classifyRelations([candidate], [answer("executes", { executes: 0.86 }, 0.9)]);
    expect(decision!.canonicalType).toBe("executes");
    expect(decision!.predicate).toBe("lleva a cabo");
    expect(decision!.identityKey).toBe("lleva a cabo");
  });
});

describe("relation classification — a predicate outside the catalog (S45.5)", () => {
  it("keeps the predicate and assigns no canonical type, never a `related_to` fallback", async () => {
    const candidate = relation("relationship:doc-1:0:0", "deja sin efecto");
    const [decision] = await classifyRelations(
      [candidate],
      [answer("requires", { requires: 0.4, executes: 0.35, governs: 0.25 }, 0.2)],
    );
    expect(decision!.classificationState).toBe("free_no_match");
    expect(decision!.canonicalType).toBeNull();
    expect(decision!.predicate).toBe("deja sin efecto");
    expect(decision!.predicate).not.toBe("related_to");
    expect(decision!.canonicalType).not.toBe("related_to");
    expect(decision!.toName).toBe("Política de retención");
  });
});

describe("relation identity — two free predicates between the same endpoints (S45.11)", () => {
  it("keeps two distinct decisions with two distinct identity keys", async () => {
    const candidates = [
      relation("relationship:doc-1:0:0", "deja sin efecto"),
      relation("relationship:doc-1:0:1", "reemplaza a"),
    ];
    const decisions = await classifyRelations(candidates, [
      answer("requires", { requires: 0.4, governs: 0.35 }, 0.15),
      answer("requires", { requires: 0.45, governs: 0.3 }, 0.2),
    ]);
    expect(decisions.map((decision) => decision.predicate)).toEqual(["deja sin efecto", "reemplaza a"]);
    expect(decisions.map((decision) => decision.identityKey)).toEqual(["deja sin efecto", "reemplaza a"]);
    expect(new Set(decisions.map((decision) => decision.identityKey)).size).toBe(2);
    expect(decisions.every((decision) => decision.classificationState === "free_no_match")).toBe(true);
  });

  it("derives the same identity key for the same predicate, so a reclassification updates one row", () => {
    expect(relationIdentityKey("Deja sin efecto")).toBe(relationIdentityKey("  deja sin efecto "));
    expect(relationIdentityKey("Deja sin efecto")).toBe("deja sin efecto");
    expect(relationIdentityKey("deja  sin efecto")).not.toBe(relationIdentityKey("deja sin efecto"));
  });

  it("refuses a blank predicate instead of deriving an empty identity key", () => {
    expect(() => relationIdentityKey("   ")).toThrow(/predicate/);
  });
});

describe("relation classification — the classification state and canonical type stay consistent", () => {
  it("never sets a canonical type without the classified state", async () => {
    const candidates = [
      relation("relationship:doc-1:0:0", "carries out"),
      relation("relationship:doc-1:0:1", "deja sin efecto"),
    ];
    const decisions = await classifyRelations(candidates, [
      answer("executes", { executes: 0.9 }, 0.95),
      answer("requires", { requires: 0.4 }, 0.1),
    ]);
    for (const decision of decisions) {
      expect(decision.canonicalType !== null).toBe(decision.classificationState === "classified");
    }
  });
});
