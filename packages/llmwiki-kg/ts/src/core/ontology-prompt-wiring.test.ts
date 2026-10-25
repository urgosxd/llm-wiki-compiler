/**
 * @file packages/llmwiki-kg/ts/src/core/ontology-prompt-wiring.test.ts
 * @description The ontology reaches the model in BOTH places it has to: the
 * entity description and the relation description.
 *
 * WHY THIS FILE EXISTS. Enforcement is two-sided and one side is easy to lose.
 * The parser drops triplets outside the declaration, and that alone would make
 * every test pass while the model was still shown the default hints — an operator
 * whose declaration silently stopped reaching the prompt would see a graph full of
 * rejections instead of the types they asked for, and no error anywhere.
 *
 * The subtle failure this pins is *which* description carries *which* list. A
 * substitution that wrote `entityTypes` into the relation description (or the
 * reverse) produces a schema where every asserted string is present, so a
 * containment test passes. These assertions read the two descriptions separately
 * for that reason.
 *
 * ## Why entities and relations cannot be separated
 *
 * The tool schema's only property is `triplets`, so an entity is expressible
 * solely as an endpoint of a relation. The tests below state that consequence
 * explicitly rather than leaving it implicit: there is no path by which a
 * standalone entity reaches the graph, and no way for a relation to exist without
 * its two endpoints.
 */

import { describe, expect, it } from "vitest";

import { buildToolSchema } from "./graph-prompt.js";
import { validateOntology } from "./ontology.js";
import { parseTripletsWithOntology } from "./ontology.js";

/** Two entity kinds and one edge kind, deliberately different in shape. */
const ONTOLOGY = validateOntology({
  entityTypes: ["ORGANIZATION", "PERSON"],
  relationshipTypes: ["WORKS_AT"],
});

/** The two `type` descriptions the schema carries, as the model reads them. */
function typeDescriptions(schema: ReturnType<typeof buildToolSchema>): {
  entity: string;
  relation: string;
} {
  const defs = schema.parameters.$defs as Record<string, { properties: Record<string, { description?: string }> }>;
  return {
    entity: defs["Entity"]?.properties["type"]?.description ?? "",
    relation: defs["Relation"]?.properties["type"]?.description ?? "",
  };
}

describe("the declared entity types reach the entity description", () => {
  it("lists exactly the declared entity types, not the defaults", () => {
    const { entity } = typeDescriptions(buildToolSchema(ONTOLOGY));

    expect(entity).toContain("'ORGANIZATION'");
    expect(entity).toContain("'PERSON'");
    // The oracle's default hints must be replaced, not supplemented: a list that
    // still advertises PRODUCT and MARKET is not a constraint.
    expect(entity).not.toContain("'PRODUCT'");
    expect(entity).not.toContain("'MARKET'");
  });

  it("does not leak the relationship types into the entity description", () => {
    const { entity } = typeDescriptions(buildToolSchema(ONTOLOGY));

    expect(entity).not.toContain("'WORKS_AT'");
  });
});

describe("the declared relationship types reach the relation description", () => {
  it("lists exactly the declared relationship types, not the defaults", () => {
    const { relation } = typeDescriptions(buildToolSchema(ONTOLOGY));

    expect(relation).toContain("'WORKS_AT'");
    expect(relation).not.toContain("'USED_FOR'");
    expect(relation).not.toContain("'PART_OF'");
  });

  it("does not leak the entity types into the relation description", () => {
    const { relation } = typeDescriptions(buildToolSchema(ONTOLOGY));

    expect(relation).not.toContain("'ORGANIZATION'");
    expect(relation).not.toContain("'PERSON'");
  });
});

describe("a declaration changes the type lists and nothing else", () => {
  it("keeps the schema structure byte-identical to the default", () => {
    // The model's output shape is a function of this structure, so the
    // declaration must only substitute description text. Anything else is a
    // change to what the model is being asked to emit.
    const byDefault = buildToolSchema();
    const declared = buildToolSchema(ONTOLOGY);

    expect(declared.name).toBe(byDefault.name);
    expect(declared.description).toBe(byDefault.description);
    expect(declared.parameters.required).toEqual(byDefault.parameters.required);
    expect(Object.keys(declared.parameters.$defs)).toEqual(
      Object.keys(byDefault.parameters.$defs),
    );
    expect(declared.parameters.$defs.Triplet).toEqual(byDefault.parameters.$defs.Triplet);
  });

  it("returns the default schema itself, not a copy, when nothing is declared", () => {
    expect(buildToolSchema()).toBe(buildToolSchema(undefined));
  });

  it("offers triplets and a separate entities array", () => {
    const schema = buildToolSchema(ONTOLOGY);
    const properties = Object.keys(schema.parameters.properties as Record<string, unknown>);

    // `entities` is the deliberate divergence from the oracle. Without it a
    // DECISION or a REQUIREMENT cannot be extracted at all, because the only
    // place a node could live was inside a triplet.
    expect(properties).toEqual(["triplets", "entities"]);
  });

  it("still requires triplets, so a model that ignores entities is valid", () => {
    // The addition is additive at the payload level: the old shape stays legal.
    // If `entities` were required, every provider that ignores an unfamiliar field
    // would return an invalid payload and a document would extract to nothing.
    const schema = buildToolSchema(ONTOLOGY);

    expect(schema.parameters.required).toEqual(["triplets"]);
    expect({
      type: schema.parameters.properties.entities.type,
      $ref: schema.parameters.properties.entities.items.$ref,
    }).toEqual({ type: "array", $ref: "#/$defs/Entity" });
  });
});

describe("entities and relationships are created together, from one triplet", () => {
  /** Builds a one-triplet payload naming both endpoints. */
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

  it("keeps the triplet that yields both endpoints and the edge", () => {
    const { triplets } = parseTripletsWithOntology(
      payload("ORGANIZATION", "WORKS_AT", "PERSON"),
      ONTOLOGY,
    );

    expect(triplets).toHaveLength(1);
    // Both endpoints, and the relation between them, come from this one record.
    expect(triplets[0]).toMatchObject({
      subjectName: "Acme",
      subjectType: "ORGANIZATION",
      relationType: "WORKS_AT",
      objectName: "Ada",
      objectType: "PERSON",
    });
  });

  it("drops the edge and both endpoints when the relation type is undeclared", () => {
    // An entity is reachable only through a surviving relation, so a bad relation
    // takes its endpoints with it. `absorbEndpoints` only runs for kept triplets.
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("ORGANIZATION", "ACQUIRES", "PERSON"),
      ONTOLOGY,
    );

    expect(triplets).toEqual([]);
    expect(rejected[0]?.reason).toBe("UNKNOWN_RELATIONSHIP_TYPE");
  });

  it("drops both endpoints when one of them has an undeclared type", () => {
    // The triplet is the unit of admission, so the valid endpoint goes with it.
    // Neither entity is created — there is no half-triplet in the graph.
    const { triplets, rejected } = parseTripletsWithOntology(
      payload("ORGANIZATION", "WORKS_AT", "ALIEN_CONSTRUCT"),
      ONTOLOGY,
    );

    expect(triplets).toEqual([]);
    expect(rejected[0]?.object).toBe("Ada");
  });
});
