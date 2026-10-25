/**
 * @file packages/llmwiki-kg/ts/src/core/ontology-prompt.test.ts
 * @description The prompt and tool schema must not move unless an ontology asks.
 *
 * WHY THIS FILE EXISTS. `graph-prompt.ts` records that the prompt text and the
 * tool schema were copied from the Python oracle because the model's output shape
 * is a function of both. Adding an ontology therefore carries a specific
 * regression risk: a well-meaning refactor that threads a parameter through the
 * renderer can change the default bytes, and nothing in the existing suite would
 * name it. These tests pin the default rendering to the oracle's literal text and
 * assert that supplying an ontology is the ONLY thing that changes it.
 */

import { describe, expect, it } from "vitest";

import { buildExtractionPrompt, buildToolSchema, KG_TOOL } from "./graph-prompt.js";
import { validateOntology } from "./ontology.js";

const ONTOLOGY = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["SUPPLIES", "EMPLOYS"],
  subtypes: [],
});

describe("default rendering is unchanged", () => {
  it("leaves KG_TOOL as the same object the oracle schema produced", () => {
    expect(Object.keys(KG_TOOL)).toEqual(["name", "description", "parameters"]);
    expect(KG_TOOL.name).toBe("KGSchema");
  });

  it("buildToolSchema with no ontology returns the exported constant", () => {
    expect(buildToolSchema()).toBe(KG_TOOL);
  });

  it("keeps the oracle's entity list in the default schema description", () => {
    const description = KG_TOOL.parameters.$defs.Entity.properties.type.description;
    expect(description).toContain("typing.Literal['PRODUCT', 'MARKET', 'TECHNOLOGY'");
  });

  it("keeps the oracle's relation list in the default schema description", () => {
    const description = KG_TOOL.parameters.$defs.Relation.properties.type.description;
    expect(description).toContain("typing.Literal['USED_BY', 'USED_FOR'");
  });

  it("keeps the extraction prompt byte-identical, typo included", () => {
    expect(buildExtractionPrompt("body", 0, "demo")).toBe(
      "Give the following text, extract the knowledge graph according to the provided schema. " +
        "Try to limit to the output 20 extracted paths.s\n" +
        "-------\n" +
        "chunk_index: 0\nstack_name: demo\n\nbody\n" +
        "-------\n",
    );
  });
});

describe("an ontology changes only the type lists", () => {
  it("renders the declared entity types", () => {
    const schema = buildToolSchema(ONTOLOGY);
    const description = schema.parameters.$defs.Entity.properties.type.description;
    expect(description).toContain("typing.Literal['COMPANY', 'PERSON']");
    expect(description).not.toContain("PRODUCT");
  });

  it("renders the declared relationship types", () => {
    const schema = buildToolSchema(ONTOLOGY);
    const description = schema.parameters.$defs.Relation.properties.type.description;
    expect(description).toContain("typing.Literal['SUPPLIES', 'EMPLOYS']");
    expect(description).not.toContain("USED_BY");
  });

  it("constrains the type field with a real enum, not only a description", () => {
    // The difference between guiding the model and cleaning up after it. With
    // `strict=False` llama_index renders the allowed types into the *description*
    // and leaves the field a bare `string`; with `strict=True` — the library's own
    // default — `possible_entities` becomes the field's type and Pydantic emits an
    // `enum`. A provider that honours the schema then cannot return a type outside
    // the list.
    const schema = buildToolSchema(ONTOLOGY);

    expect(schema.parameters.$defs.Entity.properties.type.enum).toEqual([
      "COMPANY",
      "PERSON",
    ]);
    expect(schema.parameters.$defs.Relation.properties.type.enum).toEqual([
      "SUPPLIES",
      "EMPLOYS",
    ]);
  });

  it("keeps the description beside the enum, because the sentence is the 'why'", () => {
    const type = buildToolSchema(ONTOLOGY).parameters.$defs.Entity.properties.type;

    expect(type.type).toBe("string");
    expect(type.description).toContain("typing.Literal['COMPANY', 'PERSON']");
  });

  it("leaves the default schema free of an enum, as the oracle had it", () => {
    // `strict=False` is what the default schema embodies, and it must stay that
    // way: the parity tests and the Python-parity harness observe this object.
    const type = buildToolSchema().parameters.$defs.Entity.properties.type;

    expect(type).not.toHaveProperty("enum");
  });

  it("keeps the extraction prompt independent of the ontology", () => {
    expect(buildExtractionPrompt("body", 0, "demo", ONTOLOGY)).toBe(
      buildExtractionPrompt("body", 0, "demo"),
    );
  });
});
