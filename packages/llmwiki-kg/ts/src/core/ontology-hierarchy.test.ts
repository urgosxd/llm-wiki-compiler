/**
 * @file packages/llmwiki-kg/ts/src/core/ontology-hierarchy.test.ts
 * @description Subtype (IS_A) awareness in ontology enforcement.
 *
 * WHY THIS FILE EXISTS. A hierarchy that does not affect enforcement is
 * decoration. The whole reason to declare `COMPANY IS_A ORGANIZATION` is that a
 * constraint written against the parent should admit the child: a Stack whose
 * relationship types are legal "for an ORGANIZATION" should not reject the same
 * edge merely because the model labelled the endpoint COMPANY.
 *
 * The inverse matters just as much. Hierarchy relaxes a constraint upward, never
 * downward: a constraint on COMPANY must NOT admit a bare ORGANIZATION, because
 * that would let the model widen the ontology the caller declared.
 */

import { describe, expect, it } from "vitest";

import { isEntityTypeAllowed, parseTripletsWithOntology, validateOntology } from "./ontology.js";

/** ORGANIZATION <- COMPANY <- STARTUP. */
const HIERARCHY = validateOntology({
  entityTypes: ["ORGANIZATION", "COMPANY", "STARTUP", "PERSON"],
  relationshipTypes: ["SUPPLIES", "EMPLOYS"],
  subtypes: [
    { child: "COMPANY", parent: "ORGANIZATION" },
    { child: "STARTUP", parent: "COMPANY" },
  ],
});

describe("isEntityTypeAllowed", () => {
  it("admits a declared type", () => {
    expect(isEntityTypeAllowed(HIERARCHY, "ORGANIZATION", ["ORGANIZATION"])).toBe(true);
  });

  it("admits a child where the parent is required", () => {
    expect(isEntityTypeAllowed(HIERARCHY, "COMPANY", ["ORGANIZATION"])).toBe(true);
  });

  it("admits a grandchild where the grandparent is required", () => {
    expect(isEntityTypeAllowed(HIERARCHY, "STARTUP", ["ORGANIZATION"])).toBe(true);
  });

  it("does not admit a bare parent where the child is required", () => {
    expect(isEntityTypeAllowed(HIERARCHY, "ORGANIZATION", ["COMPANY"])).toBe(false);
  });

  it("does not admit an unrelated type", () => {
    expect(isEntityTypeAllowed(HIERARCHY, "PERSON", ["ORGANIZATION"])).toBe(false);
  });
});

describe("enforcement with a hierarchy", () => {
  /** Builds a one-triplet payload with explicit endpoint types. */
  function payload(subjectType: string, objectType: string): string {
    return JSON.stringify({
      triplets: [
        {
          subject: { type: subjectType, name: "Acme" },
          relation: { type: "SUPPLIES" },
          object: { type: objectType, name: "Globex" },
        },
      ],
    });
  }

  it("keeps a triplet whose endpoints are declared children", () => {
    const { triplets, rejected } = parseTripletsWithOntology(payload("STARTUP", "COMPANY"), HIERARCHY);
    expect(triplets).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("still rejects a type that is not in the hierarchy at all", () => {
    const { rejected } = parseTripletsWithOntology(payload("ALIEN", "COMPANY"), HIERARCHY);
    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
  });
});
