/**
 * @file packages/llmwiki-kg/ts/src/core/classify/entity-classification.test.ts
 * @description Entity classification: five states, and the two that must never be faked.
 *
 * WHY THIS FILE EXISTS. `classified` is a positive decision; `free_no_match` and
 * `free_uncertain` are two DIFFERENT abstentions; `pending` and `failed` say the
 * classifier never gave a usable answer at all. Every case below also asserts the
 * negative: no substituted canonical type, and in particular never `Concept` as a
 * stand-in for "unclassified" (S27), because a default type is indistinguishable
 * from a correct classification once it is stored.
 */

import { describe, expect, it } from "vitest";

import type { EntityCandidate } from "../candidates/types.js";
import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { parseTypeCatalog } from "../catalog/parse.js";
import { parseJevConfig } from "../jev/config.js";
import type { JevScriptStep } from "../jev/doubles.js";
import { choiceAnswer, noulAnswer, scriptedJevClient, vendorResponse } from "../jev/doubles.js";
import { ENTITY_CLASSIFICATION_QUESTIONS } from "../jev/questions.js";
import { JevProviderError } from "../jev/types.js";
import { classifyCandidates } from "./batch.js";
import type { CandidateEvidence, EntityClassificationDecision } from "./types.js";

const CONFIG = parseJevConfig({});
const CATALOG = defaultTypeCatalog();
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The evidence the caller already located for a candidate (T3). */
function evidenceFor(...refs: string[]): Record<string, CandidateEvidence> {
  return Object.fromEntries(
    refs.map((ref) => [ref, { quote: "El Comité de Cambios aprueba el runbook.", context: "…" }]),
  );
}

/** One entity candidate as the extractor emitted it. */
function entity(ref: string, name: string, proposedType: string | null): EntityCandidate {
  return {
    kind: "entity",
    ref,
    source: { documentId: "doc-1", chunkId: null, chunkIndex: 0 },
    name,
    proposedType,
    description: null,
    properties: [],
  };
}

/** One scripted entity decision: the argmax label, its distribution, and the fit judgement. */
function answer(label: string, probabilities: Record<string, number>, fits: number): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, probabilities, 0.77),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** Classifies one entity candidate against the default catalog. */
async function classifyOne(
  steps: readonly JevScriptStep[],
  catalog = CATALOG,
): Promise<EntityClassificationDecision> {
  const candidate = entity("entity:doc-1:0:0", "Comité de Cambios", "Role");
  const batch = await classifyCandidates({
    candidates: [candidate],
    catalog,
    client: scriptedJevClient(steps),
    config: CONFIG,
    evidence: evidenceFor(candidate.ref),
  });
  expect(batch.entityDecisions).toHaveLength(1);
  return batch.entityDecisions[0]!;
}

describe("entity classification — a catalog type fits (S45.1)", () => {
  it("stores the canonical type and keeps the vendor readout verbatim", async () => {
    const probabilities = { Role: 0.82, Process: 0.12, Document: 0.06 };
    const decision = await classifyOne([answer("Role", probabilities, 0.91)]);
    expect(decision.classificationState).toBe("classified");
    expect(decision.canonicalType).toBe("Role");
    expect(decision.name).toBe("Comité de Cambios");
    expect(decision.readout?.probabilities).toEqual(probabilities);
    expect(decision.readout?.confidence).toBe(0.77);
    expect(decision.readout?.topProbability).toBe(0.82);
    expect(decision.catalogVersion).toBe(CATALOG.version);
  });

  it("reports support as its own unset axis rather than inheriting the classification", async () => {
    const decision = await classifyOne([answer("Role", { Role: 0.9, Process: 0.1 }, 0.95)]);
    expect(decision.supportState).toBeNull();
  });
});

describe("entity classification — a source-backed entity that fits nothing (S45.2)", () => {
  it("keeps the entity free by absence of a match and substitutes no canonical type", async () => {
    const decision = await classifyOne([answer("Role", { Role: 0.4, Process: 0.35, Document: 0.25 }, 0.2)]);
    expect(decision.classificationState).toBe("free_no_match");
    expect(decision.canonicalType).toBeNull();
    expect(decision.reason).toMatch(/no-match band/);
    expect(decision.name).toBe("Comité de Cambios");
  });
});

describe("entity classification — an ambiguous candidate (S45.3)", () => {
  it("reports free by ambiguity when the catalog fit itself is uncertain", async () => {
    const decision = await classifyOne([answer("Role", { Role: 0.6, Process: 0.4 }, 0.5)]);
    expect(decision.classificationState).toBe("free_uncertain");
    expect(decision.canonicalType).toBeNull();
    expect(decision.reason).toMatch(/uncertain band/);
  });

  it("reports free by ambiguity when no catalog type dominates the distribution", async () => {
    const decision = await classifyOne([
      answer("Role", { Role: 0.3, Process: 0.3, Document: 0.2, Policy: 0.2 }, 0.9),
    ]);
    expect(decision.classificationState).toBe("free_uncertain");
    expect(decision.canonicalType).toBeNull();
    expect(decision.reason).toMatch(/no catalog type dominates/);
  });
});

describe("entity classification — an operational problem (S25)", () => {
  it("stores a provider outage as pending, never as free by absence", async () => {
    const decision = await classifyOne([
      new JevProviderError("provider_failed", "connection reset after 3 attempts", ENDPOINT),
    ]);
    expect(decision.classificationState).toBe("pending");
    expect(decision.canonicalType).toBeNull();
    expect(decision.readout).toBeNull();
    expect(decision.reason).toContain("connection reset");
    expect(decision.classificationState).not.toBe("free_no_match");
  });

  it("stores a provider refusal as failed and keeps the candidate", async () => {
    const decision = await classifyOne([
      new JevProviderError("provider_answered", "401 from the provider", ENDPOINT, 401),
    ]);
    expect(decision.classificationState).toBe("failed");
    expect(decision.canonicalType).toBeNull();
    expect(decision.name).toBe("Comité de Cambios");
  });
});

describe("entity classification — `Concept` is never a stand-in for unclassified (S27)", () => {
  /** A caller catalog that declares exactly one entity type. */
  const CONCEPT_CATALOG = parseTypeCatalog({
    version: "2.0.0",
    entityTypes: [{ name: "Concept", definition: "An abstract idea with no concrete instance." }],
    relationTypes: [{ name: "relates", definition: "A loose association." }],
  });

  it("leaves the candidate free when the classifier finds no declared type fits", async () => {
    const decision = await classifyOne([answer("Concept", { Concept: 0.3 }, 0.1)], CONCEPT_CATALOG);
    expect(decision.classificationState).toBe("free_no_match");
    expect(decision.canonicalType).toBeNull();
  });

  it("assigns `Concept` only when the catalog declares it and the classifier picks it", async () => {
    const decision = await classifyOne([answer("Concept", { Concept: 0.86 }, 0.9)], CONCEPT_CATALOG);
    expect(decision.classificationState).toBe("classified");
    expect(decision.canonicalType).toBe("Concept");
    expect(decision.catalogVersion).toBe("2.0.0");
  });
});
