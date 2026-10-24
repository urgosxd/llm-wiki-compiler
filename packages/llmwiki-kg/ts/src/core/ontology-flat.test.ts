/**
 * @file packages/llmwiki-kg/ts/src/core/ontology-flat.test.ts
 * @description The complete semantics of a FLAT ontology: two type allowlists
 * and nothing else.
 *
 * ## Why this shape, and why it gets its own file
 *
 * A flat declaration — `entityTypes` plus `relationshipTypes`, no `subtypes` — is
 * the supported shape. It is also the default: `readSubtypes` returns `[]` when
 * the field is absent, so "no hierarchy" is not a variant of the feature, it is
 * what you get by not asking for anything else. This file pins that shape
 * completely so a future change to the hierarchy cannot silently alter the
 * behaviour every existing Stack depends on.
 *
 * ## The one thing that actually decides admission: normalisation
 *
 * With no hierarchy, admission is set membership, so the whole feature rests on
 * the declaration and the model agreeing on a spelling. Both sides normalise with
 * the same rule — `replaceAll(" ", "_").toUpperCase()` in `ontology.ts` and in
 * `graph-parse.ts` — and the tests below state that agreement from both
 * directions: a model that emits `company`, a declaration that says
 * `organic organization`. Break either side and every triplet is rejected while
 * the declaration still looks correct.
 *
 * ## What is deliberately NOT tested here
 *
 * Hierarchies. `subtypes` is validated (endpoints must be declared, cycles are
 * refused) but does not change admission, because `rejectTriplet` asks
 * `isEntityTypeAllowed` with `ontology.entityTypes` as the required set — and
 * `validateOntology` guarantees every declared child is already in that set. See
 * `ontology-hierarchy.test.ts` for the function in isolation.
 */

import { describe, expect, it } from "vitest";

import { parseTripletsWithOntology, validateOntology } from "./ontology.js";

/** Two entity kinds and one edge kind, with no hierarchy. */
const FLAT = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["SUPPLIES"],
});

/** Builds a one-triplet tool payload from explicit spellings. */
function payload(subjectType: string, relationType: string, objectType: string): string {
  return JSON.stringify({
    triplets: [
      {
        subject: { type: subjectType, name: "Acme" },
        relation: { type: relationType },
        object: { type: objectType, name: "Ada" },
      },
    ],
  });
}

describe("a flat ontology admits exactly what it declares", () => {
  it("keeps a triplet whose three types are declared", () => {
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("COMPANY", "SUPPLIES", "PERSON"),
      FLAT,
    );

    expect(triplets).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("rejects an undeclared entity type, naming the type and the side", () => {
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("ALIEN_CONSTRUCT", "SUPPLIES", "PERSON"),
      FLAT,
    );

    expect(triplets).toEqual([]);
    expect(rejected).toEqual([
      {
        subject: "Acme",
        relation: "SUPPLIES",
        object: "Ada",
        reason: "UNKNOWN_ENTITY_TYPE",
        offendingType: "ALIEN_CONSTRUCT",
      },
    ]);
  });

  it("rejects an undeclared relationship type", () => {
    const { rejected } = parseTripletsWithOntology(
      payload("COMPANY", "ACQUIRES", "PERSON"),
      FLAT,
    );

    expect(rejected[0]).toMatchObject({
      reason: "UNKNOWN_RELATIONSHIP_TYPE",
      offendingType: "ACQUIRES",
    });
  });

  it("names the entity type when both an entity and the relation are undeclared", () => {
    // Entity types are checked first, so the report names the more specific
    // cause instead of whichever check happened to run.
    const { rejected } = parseTripletsWithOntology(
      payload("ALIEN_CONSTRUCT", "ACQUIRES", "PERSON"),
      FLAT,
    );

    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
    expect(rejected[0]?.offendingType).toBe("ALIEN_CONSTRUCT");
  });

  it("rejects a type that differs from a declared one only by a trailing space", () => {
    // Trimming happens on names, not on types; a padded type is a different
    // string and must not be silently accepted by a lookup that normalises late.
    const { rejected } = parseTripletsWithOntology(
      payload("COMPANY ", "SUPPLIES", "PERSON"),
      FLAT,
    );

    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
  });
});

describe("a flat ontology agrees with the model on spelling", () => {
  it("admits types the model emits in lowercase", () => {
    const { triplets } = parseTripletsWithOntology(
      payload("company", "supplies", "person"),
      FLAT,
    );

    expect(triplets).toHaveLength(1);
  });

  it("admits a type the model emits with spaces where the declaration used one word", () => {
    // This is the real-world mismatch: the model writes prose-like labels. Both
    // sides collapse spaces to underscores, so the declaration can be written
    // either way and still match.
    const spaced = validateOntology({
      entityTypes: ["ORGANIC ORGANIZATION", "PERSON"],
      relationshipTypes: ["supplies"],
    });

    const { triplets, rejected } = parseTripletsWithOntology(
      payload("organic organization", "SUPPLIES", "person"),
      spaced,
    );

    expect(rejected).toEqual([]);
    expect(triplets[0]?.subjectType).toBe("ORGANIC_ORGANIZATION");
  });

  it("normalises the declaration itself, so a create-time value matches ingest", () => {
    const declared = validateOntology({
      entityTypes: ["company"],
      relationshipTypes: [" supplies "],
    });

    expect(declared.entityTypes).toEqual(["COMPANY"]);
    expect(declared.relationshipTypes).toEqual(["SUPPLIES"]);
  });
});

describe("a flat ontology and an absent hierarchy are the same ontology", () => {
  it("treats an omitted subtypes field and an empty one identically", () => {
    const omitted = validateOntology({
      entityTypes: ["COMPANY"],
      relationshipTypes: ["SUPPLIES"],
    });
    const empty = validateOntology({
      entityTypes: ["COMPANY"],
      relationshipTypes: ["SUPPLIES"],
      subtypes: [],
    });

    expect(omitted.subtypes).toEqual([]);
    expect(empty.subtypes).toEqual([]);
    expect(omitted.parentsOf.size).toBe(0);
    expect(empty.parentsOf.size).toBe(0);
  });

  it("decides every triplet the same way with or without an empty subtypes list", () => {
    const omitted = validateOntology({
      entityTypes: ["COMPANY", "PERSON"],
      relationshipTypes: ["SUPPLIES"],
    });
    const empty = validateOntology({
      entityTypes: ["COMPANY", "PERSON"],
      relationshipTypes: ["SUPPLIES"],
      subtypes: [],
    });
    const body = payload("COMPANY", "SUPPLIES", "PERSON");

    expect(parseTripletsWithOntology(body, omitted)).toEqual(
      parseTripletsWithOntology(body, empty),
    );
  });
});

describe("rejecting a triplet does not reject its endpoints", () => {
  it("keeps an entity reachable through a surviving triplet", () => {
    // The unit of rejection is the triplet. A type that is fine in one edge must
    // not disappear because a different edge using it was dropped — otherwise one
    // bad relation would erase a whole real entity from the graph.
    const body = JSON.stringify({
      triplets: [
        {
          subject: { type: "COMPANY", name: "Acme" },
          relation: { type: "BOGUS" },
          object: { type: "PERSON", name: "Ada" },
        },
        {
          subject: { type: "COMPANY", name: "Acme" },
          relation: { type: "SUPPLIES" },
          object: { type: "PERSON", name: "Grace" },
        },
      ],
    });

    const { triplets, rejected } = parseTripletsWithOntology(body, FLAT);

    expect(rejected).toHaveLength(1);
    expect(triplets).toHaveLength(1);
    expect(triplets[0]?.objectName).toBe("Grace");
  });

  it("reports one rejection per dropped triplet, in payload order", () => {
    const body = JSON.stringify({
      triplets: [
        {
          subject: { type: "ALIEN_CONSTRUCT", name: "A" },
          relation: { type: "SUPPLIES" },
          object: { type: "PERSON", name: "B" },
        },
        {
          subject: { type: "COMPANY", name: "C" },
          relation: { type: "BOGUS" },
          object: { type: "PERSON", name: "D" },
        },
      ],
    });

    const { triplets, rejected } = parseTripletsWithOntology(body, FLAT);

    expect(triplets).toEqual([]);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "UNKNOWN_ENTITY_TYPE",
      "UNKNOWN_RELATIONSHIP_TYPE",
    ]);
  });
});
