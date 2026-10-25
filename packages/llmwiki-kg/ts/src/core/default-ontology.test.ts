/**
 * @file packages/llmwiki-kg/ts/src/core/default-ontology.test.ts
 * @description Locks the vocabulary an unconfigured Stack is enforced against.
 *
 * These tests exist to stop one specific regression: replacing this list with
 * llama_index's `DEFAULT_ENTITIES` / `DEFAULT_RELATIONS`. That swap is tempting
 * because it would leave the tool schema byte-identical, and it is wrong because
 * the llama_index list admits no `COMPANY` and no `EMPLOYS` — it would reject the
 * most natural sentence in this domain while admitting `MISCELLANEOUS`.
 *
 * The assertion style is deliberately behavioural: it parses real triplets
 * through the real enforcement path rather than comparing arrays, so a list that
 * happens to contain `COMPANY` as a string but never reaches enforcement still
 * fails here.
 */

import { describe, expect, it } from "vitest";

import { defaultOntology, DEFAULT_ENTITY_TYPES, DEFAULT_RELATIONSHIP_TYPES } from "./default_ontology.js";
import { parseTripletsWithOntology } from "./ontology.js";

/** One triplet payload in the shape the tool call actually returns. */
function payload(
  subjectType: string,
  relationType: string,
  objectType: string,
): string {
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

describe("the default ontology", () => {
  it("admits the canonical company-employs-person triplet", () => {
    // The measured reason llama_index's list was rejected: `COMPANY` is not in
    // it, so enforcing that list would drop this and yield an empty graph from a
    // perfectly ordinary sentence.
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("COMPANY", "EMPLOYS", "PERSON"),
      defaultOntology(),
    );

    expect(rejected).toEqual([]);
    expect(triplets).toHaveLength(1);
  });

  it("admits every entity type it declares and rejects one it does not", () => {
    const ontology = defaultOntology();

    for (const entityType of DEFAULT_ENTITY_TYPES) {
      const { rejected } = parseTripletsWithOntology(
        payload(entityType, "HAS", "CONCEPT"),
        ontology,
      );
      expect(rejected, `${entityType} should be admitted`).toEqual([]);
    }

    const { rejected } = parseTripletsWithOntology(
      payload("ALIEN_CONSTRUCT", "HAS", "CONCEPT"),
      ontology,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
  });

  it("admits every relationship type on a pair its constraint allows", () => {
    // The vocabulary test, independent of the pair constraints: each relationship
    // is exercised on a pair that is valid for it, so this fails only when a
    // declared relationship is missing from enforcement.
    const ontology = defaultOntology();
    const validPair: Record<string, readonly [string, string]> = {
      EMPLOYS: ["COMPANY", "PERSON"],
      WORKS_AT: ["PERSON", "COMPANY"],
      OWNS: ["COMPANY", "PRODUCT"],
    };

    for (const relationshipType of DEFAULT_RELATIONSHIP_TYPES) {
      const [subject, object] = validPair[relationshipType] ?? ["COMPANY", "PERSON"];
      const { rejected } = parseTripletsWithOntology(
        payload(subject, relationshipType, object),
        ontology,
      );
      expect(rejected, `${relationshipType} should be admitted`).toEqual([]);
    }

    const { rejected } = parseTripletsWithOntology(
      payload("COMPANY", "BOGUS", "PERSON"),
      ontology,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("UNKNOWN_RELATIONSHIP_TYPE");
  });

  it("does not admit MISCELLANEOUS, so the free-text column cannot return", () => {
    // A type meaning "anything" is the permissive behaviour this default
    // replaces. Keeping it would let the model route every unknown thing into
    // one bucket and look compliant.
    expect(DEFAULT_ENTITY_TYPES as readonly string[]).not.toContain("MISCELLANEOUS");
  });

  it("refuses the nonsense pairs the unconstrained default used to admit", () => {
    // Measured before constraints existed: `TIME EMPLOYS PERSON` and
    // `LOCATION ACQUIRES DECISION` were both admitted, so the default was 20
    // verbs with no semantics. These two are the ones that made that visible.
    const ontology = defaultOntology();

    const timeEmploys = parseTripletsWithOntology(payload("TIME", "EMPLOYS", "PERSON"), ontology);
    expect(timeEmploys.rejected[0]?.reason).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");

    const decisionOwns = parseTripletsWithOntology(payload("DECISION", "OWNS", "PERSON"), ontology);
    expect(decisionOwns.rejected[0]?.reason).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");
  });

  it("refuses a person employing a person and a company employing a company", () => {
    const ontology = defaultOntology();

    expect(
      parseTripletsWithOntology(payload("PERSON", "EMPLOYS", "PERSON"), ontology).rejected[0]?.reason,
    ).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");
    expect(
      parseTripletsWithOntology(payload("COMPANY", "EMPLOYS", "COMPANY"), ontology).rejected[0]?.reason,
    ).toBe("OBJECT_TYPE_NOT_IN_RANGE");
  });

  it("admits the true sentences the constraints must not refuse", () => {
    // The cost side of the trade: a rejected triplet takes its endpoints with it,
    // so an over-tight default deletes entities a document really named. Each of
    // these is a sentence a real document contains.
    const ontology = defaultOntology();
    const trueSentences: ReadonlyArray<readonly [string, string, string]> = [
      ["COMPANY", "EMPLOYS", "PERSON"],
      ["TEAM", "EMPLOYS", "PERSON"],
      ["ORGANIZATION", "EMPLOYS", "PERSON"],
      ["PERSON", "WORKS_AT", "COMPANY"],
      ["PERSON", "WORKS_AT", "TEAM"],
      ["COMPANY", "OWNS", "PRODUCT"],
      ["PERSON", "OWNS", "DOCUMENT"],
      ["ORGANIZATION", "OWNS", "SYSTEM"],
    ];

    for (const [subject, relation, object] of trueSentences) {
      expect(
        parseTripletsWithOntology(payload(subject, relation, object), ontology).rejected,
        `${subject} ${relation} ${object} must be admitted`,
      ).toEqual([]);
    }
  });

  it("leaves the ubiquitous relationships unconstrained on purpose", () => {
    // `PART_OF`, `HAS` and `IS_A` can legitimately connect almost any pair, so a
    // guess about which combination is impossible would be wrong often enough to
    // hurt. This pins the decision rather than leaving it implicit.
    const ontology = defaultOntology();
    const ubiquitous = ["PART_OF", "HAS", "IS_A"];

    for (const relation of ubiquitous) {
      expect(ontology.constraintsOf.has(relation), `${relation} must stay unconstrained`).toBe(false);
    }

    expect(parseTripletsWithOntology(payload("REQUIREMENT", "PART_OF", "PROCESS"), ontology).rejected)
      .toEqual([]);
    expect(parseTripletsWithOntology(payload("DOCUMENT", "PART_OF", "DECISION"), ontology).rejected)
      .toEqual([]);
  });

  it("is flat, asserting no subtype structure nobody declared", () => {
    expect(defaultOntology().subtypes).toEqual([]);
  });

  it("returns a fresh instance each call", () => {
    // `Ontology` carries a derived `parentsOf` map, so handing out one shared
    // instance would let any holder mutate a graph-wide singleton.
    expect(defaultOntology()).not.toBe(defaultOntology());
  });

  it("declares names already normalised, matching what the parser produces", () => {
    // A declaration of "company" would be normalised to COMPANY by
    // validateOntology anyway, but the exported constants are read by humans and
    // by documentation, so they must read the way the stored graph reads.
    for (const name of [...DEFAULT_ENTITY_TYPES, ...DEFAULT_RELATIONSHIP_TYPES]) {
      expect(name).toBe(name.replaceAll(" ", "_").toUpperCase());
    }
  });

  it("declares no duplicate names within either list", () => {
    expect(new Set(DEFAULT_ENTITY_TYPES).size).toBe(DEFAULT_ENTITY_TYPES.length);
    expect(new Set(DEFAULT_RELATIONSHIP_TYPES).size).toBe(DEFAULT_RELATIONSHIP_TYPES.length);
  });
});
