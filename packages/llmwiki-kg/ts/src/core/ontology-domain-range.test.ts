/**
 * @file packages/llmwiki-kg/ts/src/core/ontology-domain-range.test.ts
 * @description Pair constraints: which entity types one relationship may connect.
 *
 * WHY THIS FILE EXISTS. Declaring `entityTypes` and `relationshipTypes` was
 * measured to constrain each endpoint independently and never the pair. All four
 * combinations of `COMPANY` / `PERSON` with `EMPLOYS` were admitted, including
 * `PERSON EMPLOYS PERSON`, because `rejectTriplet` checks subject type, object
 * type and relation type as three separate allowlist lookups.
 *
 * A `relationships` entry with `domains` and `ranges` adds the missing constraint
 * for one relationship. The design constraint that shapes every test here is that
 * it must be ADDITIVE: a relationship absent from that list keeps exactly the
 * behaviour it had, so every ontology written before this field existed still
 * loads and still admits the same triplets.
 */

import { describe, expect, it } from "vitest";

import { OntologyError, parseTripletsWithOntology, validateOntology } from "./ontology.js";

/** One triplet payload in the shape the tool call actually returns. */
function payload(subjectType: string, relation: string, objectType: string): string {
  return JSON.stringify({
    triplets: [
      {
        subject: { type: subjectType, name: "Acme" },
        relation: { type: relation },
        object: { type: objectType, name: "Ada" },
      },
    ],
  });
}

/** A declaration whose only relationship carries a domain and a range. */
const CONSTRAINED = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
  relationships: [{ type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] }],
});

describe("a declared domain and range", () => {
  it("admits the triplet it describes", () => {
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("COMPANY", "EMPLOYS", "PERSON"),
      CONSTRAINED,
    );

    expect(rejected).toEqual([]);
    expect(triplets).toHaveLength(1);
  });

  it("refuses a PERSON employing a PERSON", () => {
    // The measured hole this closes. Before pair constraints, this was admitted
    // because every endpoint satisfied the allowlist on its own.
    const { rejected } = parseTripletsWithOntology(
      payload("PERSON", "EMPLOYS", "PERSON"),
      CONSTRAINED,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");
    expect(rejected[0]?.offendingType).toBe("PERSON");
  });

  it("refuses a COMPANY employing a COMPANY, naming the object", () => {
    const { rejected } = parseTripletsWithOntology(
      payload("COMPANY", "EMPLOYS", "COMPANY"),
      CONSTRAINED,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("OBJECT_TYPE_NOT_IN_RANGE");
    expect(rejected[0]?.offendingType).toBe("COMPANY");
  });

  it("reports the subject before the object when both ends are wrong", () => {
    // Fixed order, so a triplet wrong on both ends has one stable explanation.
    const { rejected } = parseTripletsWithOntology(
      payload("PERSON", "EMPLOYS", "COMPANY"),
      CONSTRAINED,
    );

    expect(rejected[0]?.reason).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");
  });
});

describe("an unconstrained side means any declared type", () => {
  it("accepts any subject when only a range is declared", () => {
    const ontology = validateOntology({
      entityTypes: ["COMPANY", "PERSON"],
      relationshipTypes: ["EMPLOYS"],
      relationships: [{ type: "EMPLOYS", ranges: ["PERSON"] }],
    });

    expect(parseTripletsWithOntology(payload("PERSON", "EMPLOYS", "PERSON"), ontology).rejected)
      .toEqual([]);
    expect(parseTripletsWithOntology(payload("PERSON", "EMPLOYS", "COMPANY"), ontology).rejected)
      .toHaveLength(1);
  });
});

describe("the subtype hierarchy now decides admission", () => {
  it("admits a COMPANY where the domain asks for ORGANIZATION", () => {
    // This is where the hierarchy finally does work. It was decorative before
    // pair constraints existed: `rejectTriplet` passed the full allowlist as the
    // required set, so every declared type matched by identity and the ancestor
    // walk never decided anything.
    const ontology = validateOntology({
      entityTypes: ["ORGANIZATION", "COMPANY", "PERSON"],
      relationshipTypes: ["EMPLOYS"],
      relationships: [{ type: "EMPLOYS", domains: ["ORGANIZATION"], ranges: ["PERSON"] }],
      subtypes: [{ child: "COMPANY", parent: "ORGANIZATION" }],
    });

    const { rejected } = parseTripletsWithOntology(payload("COMPANY", "EMPLOYS", "PERSON"), ontology);

    expect(rejected).toEqual([]);
  });

  it("still refuses an unrelated type under the same domain", () => {
    const ontology = validateOntology({
      entityTypes: ["ORGANIZATION", "COMPANY", "PERSON", "TECHNOLOGY"],
      relationshipTypes: ["EMPLOYS"],
      relationships: [{ type: "EMPLOYS", domains: ["ORGANIZATION"], ranges: ["PERSON"] }],
      subtypes: [{ child: "COMPANY", parent: "ORGANIZATION" }],
    });

    const { rejected } = parseTripletsWithOntology(
      payload("TECHNOLOGY", "EMPLOYS", "PERSON"),
      ontology,
    );

    expect(rejected[0]?.reason).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");
  });
});

describe("a relationship without a constraint keeps its old behaviour", () => {
  it("admits every endpoint combination", () => {
    // The additivity guarantee. This is the exact behaviour measured before the
    // feature existed, and it must survive for declarations that never opt in.
    const ontology = validateOntology({
      entityTypes: ["COMPANY", "PERSON"],
      relationshipTypes: ["EMPLOYS", "HAS_ALIAS"],
      relationships: [{ type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] }],
    });

    for (const [subjectType, objectType] of [
      ["PERSON", "COMPANY"],
      ["COMPANY", "COMPANY"],
      ["PERSON", "PERSON"],
    ] as const) {
      expect(
        parseTripletsWithOntology(payload(subjectType, "HAS_ALIAS", objectType), ontology).rejected,
        `${subjectType} HAS_ALIAS ${objectType} should be unconstrained`,
      ).toEqual([]);
    }
  });

  it("loads a declaration written before constraints existed", () => {
    const ontology = validateOntology({
      entityTypes: ["COMPANY", "PERSON"],
      relationshipTypes: ["EMPLOYS"],
    });

    expect(ontology.constraintsOf.size).toBe(0);
    expect(parseTripletsWithOntology(payload("PERSON", "EMPLOYS", "PERSON"), ontology).rejected)
      .toEqual([]);
  });
});

describe("a relationship-only rejection keeps the entities", () => {
  it("returns both endpoints when only the relation is wrong", () => {
    // Measured before this: `[Globex PARTNERS_WITH Initech]` left neither name as
    // a row, even though the document named both and the ontology declares
    // COMPANY. One unrecognised verb deleted two real entities.
    const { rejected, rescued } = parseTripletsWithOntology(
      payload("COMPANY", "PARTNERS_WITH", "COMPANY"),
      CONSTRAINED,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("UNKNOWN_RELATIONSHIP_TYPE");
    expect(rescued).toEqual([
      { name: "Acme", type: "COMPANY" },
      { name: "Ada", type: "COMPANY" },
    ]);
  });

  it("returns both endpoints when the pair violates a domain or range", () => {
    // Same reasoning: the verb is declared, the types are declared, only the
    // combination is impossible. The nodes are real; the edge is not.
    const personEmploys = parseTripletsWithOntology(
      payload("PERSON", "EMPLOYS", "PERSON"),
      CONSTRAINED,
    );
    expect(personEmploys.rejected[0]?.reason).toBe("SUBJECT_TYPE_NOT_IN_DOMAIN");
    expect(personEmploys.rescued.map((entity) => entity.type)).toEqual(["PERSON", "PERSON"]);

    const companyEmploysCompany = parseTripletsWithOntology(
      payload("COMPANY", "EMPLOYS", "COMPANY"),
      CONSTRAINED,
    );
    expect(companyEmploysCompany.rejected[0]?.reason).toBe("OBJECT_TYPE_NOT_IN_RANGE");
    expect(companyEmploysCompany.rescued).toHaveLength(2);
  });

  it("does NOT rescue anything when an entity type is undeclared", () => {
    // The boundary of the recovery. An undeclared entity type means the model
    // produced something the ontology does not have, so there is nothing to keep —
    // and keeping it would defeat the allowlist this feature exists to enforce.
    const { rejected, rescued } = parseTripletsWithOntology(
      payload("ALIEN_CONSTRUCT", "EMPLOYS", "PERSON"),
      CONSTRAINED,
    );

    expect(rejected[0]?.reason).toBe("UNKNOWN_ENTITY_TYPE");
    expect(rescued).toEqual([]);
  });

  it("rescues nothing when every triplet is admitted", () => {
    const { rejected, rescued } = parseTripletsWithOntology(
      payload("COMPANY", "EMPLOYS", "PERSON"),
      CONSTRAINED,
    );

    expect(rejected).toEqual([]);
    expect(rescued).toEqual([]);
  });
});

describe("a constraint that could never fire is refused at load", () => {
  it("rejects a constraint on an undeclared relationship", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["COMPANY"],
        relationshipTypes: ["HAS_ALIAS"],
        relationships: [{ type: "EMPLOYS", domains: ["COMPANY"] }],
      }),
    ).toThrow(/EMPLOYS.*not declared in "relationshipTypes"/);
  });

  it("rejects a domain naming an undeclared entity type", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["PERSON"],
        relationshipTypes: ["EMPLOYS"],
        relationships: [{ type: "EMPLOYS", domains: ["COMPANY"] }],
      }),
    ).toThrow(/domains references "COMPANY"/);
  });

  it("rejects a range naming an undeclared entity type", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["COMPANY"],
        relationshipTypes: ["EMPLOYS"],
        relationships: [{ type: "EMPLOYS", ranges: ["PERSON"] }],
      }),
    ).toThrow(/ranges references "PERSON"/);
  });

  it("rejects the same relationship constrained twice", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["COMPANY", "PERSON"],
        relationshipTypes: ["EMPLOYS"],
        relationships: [
          { type: "EMPLOYS", domains: ["COMPANY"] },
          { type: "employs", ranges: ["PERSON"] },
        ],
      }),
    ).toThrow(OntologyError);
  });

  it("normalises domain and range names like every other type name", () => {
    const ontology = validateOntology({
      entityTypes: ["company", "person"],
      relationshipTypes: ["employs"],
      relationships: [{ type: "employs", domains: ["company"], ranges: ["person"] }],
    });

    expect(ontology.constraintsOf.get("EMPLOYS")).toEqual({
      type: "EMPLOYS",
      domains: ["COMPANY"],
      ranges: ["PERSON"],
    });
  });
});
