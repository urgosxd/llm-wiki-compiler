/**
 * @file packages/llmwiki-kg/ts/src/core/ontology-enforcement.test.ts
 * @description Enforcing a declared ontology during extraction.
 *
 * WHY THIS FILE EXISTS. Parsing a triplet and *accepting* it are different
 * questions, and the oracle only ever answered the first: with `strict=False`,
 * llama_index stores whatever type the model emits. Once a caller declares an
 * ontology, the second question has to be answered too, and the answer has to be
 * visible. A silently dropped triplet makes a thin extraction
 * indistinguishable from a tight ontology, so every rejection carries a reason.
 *
 * The rejection rejects the TRIPLET, not its endpoints: an unknown entity type
 * drops the edge it participates in, but an endpoint that survives another valid
 * edge is still a real entity.
 *
 * `parseTriplets` keeps its exact existing signature. This module adds a
 * separate, opt-in entry point rather than widening the return of a function the
 * ingest route already calls, so an ignored ontology cannot change default
 * behaviour anywhere.
 */

import { describe, expect, it } from "vitest";

import { parseTriplets } from "./graph-parse.js";
import { parseTripletsWithOntology } from "./ontology.js";
import { validateOntology } from "./ontology.js";

/** An ontology that permits exactly two entity kinds and one edge kind. */
const ONTOLOGY = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["SUPPLIES"],
  subtypes: [],
});

/** Builds a one-triplet tool payload. */
function payload(subjectType: string, relationType: string, objectType: string): string {
  return JSON.stringify({
    triplets: [
      {
        subject: { type: subjectType, name: "Acme" },
        relation: { type: relationType },
        object: { type: objectType, name: "Globex" },
      },
    ],
  });
}

describe("parseTripletsWithOntology", () => {
  it("keeps a triplet whose types are all declared", () => {
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("COMPANY", "SUPPLIES", "COMPANY"),
      ONTOLOGY,
    );
    expect(triplets).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("drops a triplet with an undeclared relationship type and reports it", () => {
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("COMPANY", "ACQUIRED", "COMPANY"),
      ONTOLOGY,
    );
    expect(triplets).toEqual([]);
    expect(rejected).toEqual([
      {
        subject: "Acme",
        relation: "ACQUIRED",
        object: "Globex",
        reason: "UNKNOWN_RELATIONSHIP_TYPE",
        offendingType: "ACQUIRED",
      },
    ]);
  });

  it("drops a triplet with an undeclared subject type", () => {
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("ALIEN", "SUPPLIES", "COMPANY"),
      ONTOLOGY,
    );
    expect(triplets).toEqual([]);
    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
    expect(rejected[0]?.offendingType).toBe("ALIEN");
  });

  it("names the entity type before the relationship type when both are wrong", () => {
    const { rejected } = parseTripletsWithOntology(payload("ALIEN", "ACQUIRED", "COMPANY"), ONTOLOGY);
    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
  });
});

describe("parseTriplets without an ontology", () => {
  it("accepts any type, as the oracle's strict=False does", () => {
    const triplets = parseTriplets(payload("ANYTHING", "WHATEVER", "ELSE"));
    expect(triplets).toHaveLength(1);
    expect(triplets[0]?.subjectType).toBe("ANYTHING");
  });
});
