/**
 * @file packages/llmwiki-kg/ts/src/core/classify/classify-batch.test.ts
 * @description The classification stage's entry point: one batch, independent axes, no I/O.
 *
 * WHY THIS FILE EXISTS. S32 is a claim about independence — a free node must not
 * force its relations free, and a classified node must not force its relations
 * classified — and the only way to hold it is to observe both shapes in one batch.
 * S35 is the same kind of claim across axes: source support and schema
 * compatibility are recorded side by side, so a supported fact can be in conflict
 * with the catalog and still keep the classification the classifier gave it. The
 * last two cases pin the entry point's failure behaviour: a provider problem is a
 * decision outcome, and a missing quote is a caller bug that never reaches Jev.
 */

import { describe, expect, it } from "vitest";

import type { EntityCandidate, RelationCandidate } from "../candidates/types.js";
import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { parseJevConfig } from "../jev/config.js";
import type { JevScriptStep } from "../jev/doubles.js";
import { choiceAnswer, noulAnswer, scriptedJevClient, vendorResponse } from "../jev/doubles.js";
import { ENTITY_CLASSIFICATION_QUESTIONS, RELATION_CLASSIFICATION_QUESTIONS } from "../jev/questions.js";
import { JevProviderError } from "../jev/types.js";
import { classifyCandidates } from "./batch.js";
import { ClassificationInputError } from "./types.js";
import type { CandidateEvidence, ClassifyCandidatesInput } from "./types.js";

const CONFIG = parseJevConfig({});
const CATALOG = defaultTypeCatalog();
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The evidence the caller already located for every candidate in the batch (T3). */
function evidenceFor(...refs: string[]): Record<string, CandidateEvidence> {
  return Object.fromEntries(refs.map((ref) => [ref, { quote: "El Comité aprueba el runbook.", context: "…" }]));
}

/** One entity candidate. */
function entity(ref: string, name: string): EntityCandidate {
  return {
    kind: "entity",
    ref,
    source: { documentId: "doc-1", chunkId: null, chunkIndex: 0 },
    name,
    proposedType: null,
    description: null,
    properties: [],
  };
}

/** One relation candidate between two already declared entities. */
function relation(ref: string, from: string, predicate: string, to: string): RelationCandidate {
  return {
    kind: "relationship",
    ref,
    source: { documentId: "doc-1", chunkId: null, chunkIndex: 0 },
    fromName: from,
    toName: to,
    predicate,
    description: null,
  };
}

/** One scripted entity decision. */
function entityAnswer(label: string, probabilities: Record<string, number>, fits: number): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, probabilities, 0.8),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** One scripted relation decision. */
function relationAnswer(label: string, probabilities: Record<string, number>, fits: number): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, probabilities, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** Runs one batch through a scripted client. */
function runBatch(
  input: Omit<ClassifyCandidatesInput, "catalog" | "config">,
): ReturnType<typeof classifyCandidates> {
  return classifyCandidates({ ...input, catalog: CATALOG, config: CONFIG });
}

describe("classifyCandidates — nodes and relations are classified independently (S32)", () => {
  it("classifies a typed relation between two free nodes, leaving both nodes free (S45.6)", async () => {
    const role = entity("entity:doc-1:0:0", "Comité de Cambios");
    const process = entity("entity:doc-1:0:1", "Gestión de cambios");
    const edge = relation("relationship:doc-1:0:0", role.name, "carries out", process.name);
    const batch = await runBatch({
      candidates: [role, process, edge],
      client: scriptedJevClient([
        entityAnswer("Role", { Role: 0.4, Process: 0.3 }, 0.2),
        entityAnswer("Process", { Process: 0.45, Role: 0.3 }, 0.25),
        relationAnswer("executes", { executes: 0.88 }, 0.94),
      ]),
      evidence: evidenceFor(role.ref, process.ref, edge.ref),
    });
    expect(batch.entityDecisions.map((decision) => decision.classificationState)).toEqual([
      "free_no_match",
      "free_no_match",
    ]);
    const relationDecision = batch.relationDecisions[0]!;
    expect(relationDecision.classificationState).toBe("classified");
    expect(relationDecision.canonicalType).toBe("executes");
    expect(relationDecision.compatibility).toBe("indeterminate");
  });

  it("keeps a free relation free between two classified nodes (S45.7)", async () => {
    const role = entity("entity:doc-1:0:0", "Comité de Cambios");
    const process = entity("entity:doc-1:0:1", "Gestión de cambios");
    const edge = relation("relationship:doc-1:0:0", role.name, "deja sin efecto", process.name);
    const batch = await runBatch({
      candidates: [role, process, edge],
      client: scriptedJevClient([
        entityAnswer("Role", { Role: 0.9 }, 0.95),
        entityAnswer("Process", { Process: 0.9 }, 0.95),
        relationAnswer("requires", { requires: 0.4, governs: 0.3 }, 0.2),
      ]),
      evidence: evidenceFor(role.ref, process.ref, edge.ref),
    });
    expect(batch.entityDecisions.map((decision) => decision.canonicalType)).toEqual(["Role", "Process"]);
    const relationDecision = batch.relationDecisions[0]!;
    expect(relationDecision.classificationState).toBe("free_no_match");
    expect(relationDecision.canonicalType).toBeNull();
    expect(relationDecision.predicate).toBe("deja sin efecto");
    expect(relationDecision.compatibility).toBe("indeterminate");
  });
});

describe("classifyCandidates — support and compatibility are separate axes (S35)", () => {
  it("keeps a supported but conflicting relation classified, with the conflict recorded", async () => {
    const process = entity("entity:doc-1:0:0", "Gestión de cambios");
    const role = entity("entity:doc-1:0:1", "Comité de Cambios");
    const edge = relation("relationship:doc-1:0:0", process.name, "carries out", role.name);
    const batch = await runBatch({
      candidates: [process, role, edge],
      client: scriptedJevClient([
        entityAnswer("Process", { Process: 0.9 }, 0.95),
        entityAnswer("Role", { Role: 0.9 }, 0.95),
        relationAnswer("executes", { executes: 0.9 }, 0.95),
      ]),
      evidence: evidenceFor(process.ref, role.ref, edge.ref),
      supportStates: { [edge.ref]: "supported" },
    });
    const relationDecision = batch.relationDecisions[0]!;
    expect(relationDecision.supportState).toBe("supported");
    expect(relationDecision.compatibility).toBe("conflict");
    expect(relationDecision.classificationState).toBe("classified");
    expect(relationDecision.canonicalType).toBe("executes");
  });

  it("reports compatible for a supported fact whose triple the catalog permits", async () => {
    const role = entity("entity:doc-1:0:0", "Comité de Cambios");
    const process = entity("entity:doc-1:0:1", "Gestión de cambios");
    const edge = relation("relationship:doc-1:0:0", role.name, "carries out", process.name);
    const batch = await runBatch({
      candidates: [role, process, edge],
      client: scriptedJevClient([
        entityAnswer("Role", { Role: 0.9 }, 0.95),
        entityAnswer("Process", { Process: 0.9 }, 0.95),
        relationAnswer("executes", { executes: 0.9 }, 0.95),
      ]),
      evidence: evidenceFor(role.ref, process.ref, edge.ref),
      supportStates: { [edge.ref]: "supported" },
    });
    expect(batch.relationDecisions[0]!.supportState).toBe("supported");
    expect(batch.relationDecisions[0]!.compatibility).toBe("compatible");
  });
});

describe("classifyCandidates — batch boundaries", () => {
  it("returns one decision per candidate in order, and never throws for a provider problem", async () => {
    const first = entity("entity:doc-1:0:0", "Comité de Cambios");
    const second = entity("entity:doc-1:0:1", "Gestión de cambios");
    const batch = await runBatch({
      candidates: [first, second],
      client: scriptedJevClient([
        entityAnswer("Role", { Role: 0.9 }, 0.95),
        new JevProviderError("provider_failed", "connection reset after 3 attempts", ENDPOINT),
      ]),
      evidence: evidenceFor(first.ref, second.ref),
    });
    expect(batch.decisions.map((decision) => decision.ref)).toEqual([first.ref, second.ref]);
    expect(batch.decisions.map((decision) => decision.classificationState)).toEqual(["classified", "pending"]);
    expect(batch.catalogVersion).toBe(CATALOG.version);
  });

  it("refuses a candidate with no located evidence before asking the client anything", async () => {
    const candidate = entity("entity:doc-1:0:0", "Comité de Cambios");
    const client = scriptedJevClient([]);
    const attempt = runBatch({ candidates: [candidate], client, evidence: {} });
    await expect(attempt).rejects.toThrow(ClassificationInputError);
    await expect(attempt).rejects.toThrow(/entity:doc-1:0:0/);
    expect(client.requests).toHaveLength(0);
  });
});

describe("classifyCandidates — endpoint types the caller already knows", () => {
  it("checks compatibility against stored endpoint types a version sweep did not re-classify", async () => {
    // A reclassification run classifies the STALE rows, so a relation's endpoints are
    // usually not entity candidates of its batch. Without the seed their types would
    // read as unknown and storage's `compatible` verdict would be recomputed as
    // `indeterminate` — a silent downgrade of an established fact.
    const edge = relation("relationship:doc-1:0:0", "Comité de Cambios", "carries out", "Gestión de cambios");
    const seeded = await runBatch({
      candidates: [edge],
      client: scriptedJevClient([relationAnswer("executes", { executes: 0.9 }, 0.95)]),
      evidence: evidenceFor(edge.ref),
      // Keyed with the same fold every candidate name uses (accents preserved).
      endpointTypes: new Map([
        ["comité_de_cambios", "Role"],
        ["gestión_de_cambios", "Process"],
      ]),
    });
    expect(seeded.relationDecisions[0]!.compatibility).toBe("compatible");

    // A fresh answer beats a stored one: when the batch itself decides that an endpoint
    // is free, the seed for that name is dropped and the verdict becomes indeterminate.
    const overridden = await runBatch({
      candidates: [entity(edge.ref, "Comité de Cambios"), edge],
      client: scriptedJevClient([
        entityAnswer("Role", { Role: 0.3 }, 0.05),
        relationAnswer("executes", { executes: 0.9 }, 0.95),
      ]),
      evidence: evidenceFor(edge.ref),
      endpointTypes: new Map([["comité_de_cambios", "Role"]]),
    });
    expect(overridden.entityDecisions[0]!.classificationState).toBe("free_no_match");
    expect(overridden.relationDecisions[0]!.compatibility).toBe("indeterminate");
  });
});
