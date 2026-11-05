/**
 * @file packages/llmwiki-kg/ts/src/core/llm/schema-validation.test.ts
 * @description Counting schema violations on providers that ignore the `enum`.
 *
 * WHY THIS FILE EXISTS. The tool schema narrows an entity's or a relation's
 * `type` to a JSON Schema `enum`, but only a provider that honours `strict: true`
 * enforces it. On `anthropic` and on the default `gateway` the `enum` is a hint:
 * an out-of-ontology type arrives untouched, and the triplet parser only checks
 * that the field is a string. The model's non-compliance is therefore invisible,
 * and looks exactly like a legitimate type the model chose.
 *
 * The cases below pin the count itself, through the public
 * `countSchemaViolations` only: one bad endpoint, one bad relation, a clean
 * payload, the default run with no `enum` to enforce, and a payload that does not
 * parse at all.
 */

import { describe, expect, it } from "vitest";

import { buildToolSchema } from "../graph-prompt.js";
import { validateOntology } from "../ontology.js";
import { countSchemaViolations } from "./schema-validation.js";

/** A declaration whose types are deliberately far from the model's defaults. */
const ONTOLOGY = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["SUPPLIES", "EMPLOYS"],
  subtypes: [],
});

/** The schema actually sent to the provider when that ontology is declared. */
const CONSTRAINED = buildToolSchema(ONTOLOGY);

/** One triplet payload, with the three types under test parameterised. */
function payload(subjectType: string, relationType: string, objectType: string): string {
  return JSON.stringify({
    triplets: [
      {
        subject: { type: subjectType, name: "Acme" },
        relation: { type: relationType },
        object: { type: objectType, name: "Initrode" },
      },
    ],
  });
}

describe("countSchemaViolations", () => {
  it("counts an entity type outside the declared enum", () => {
    // The model ignored the schema on this provider: `PRODUCT` is not declared.
    expect(countSchemaViolations(payload("PRODUCT", "SUPPLIES", "PERSON"), CONSTRAINED)).toBe(1);
  });

  it("counts a relation type outside the declared enum", () => {
    expect(countSchemaViolations(payload("COMPANY", "USED_FOR", "PERSON"), CONSTRAINED)).toBe(1);
  });

  it("counts nothing for a fully compliant payload", () => {
    expect(countSchemaViolations(payload("COMPANY", "SUPPLIES", "PERSON"), CONSTRAINED)).toBe(0);
  });

  it("counts nothing when the schema carries no enum to enforce", () => {
    // The default run: `buildToolSchema()` returns the oracle's `strict=False`
    // shape, which constrains nothing. Enforcing `DEFAULT_ENTITIES` here would
    // change what a default extraction accepts, which nobody asked for.
    const types = payload("PRODUCT", "USED_FOR", "SOMETHING_ELSE");
    expect(countSchemaViolations(types, buildToolSchema())).toBe(0);
  });

  it("counts every violating position across several triplets", () => {
    const twoTriplets = JSON.stringify({
      triplets: [
        {
          subject: { type: "PRODUCT", name: "Acme" },
          relation: { type: "USED_FOR" },
          object: { type: "PERSON", name: "Ada" },
        },
        {
          subject: { type: "COMPANY", name: "Acme" },
          relation: { type: "SUPPLIES" },
          object: { type: "MARKET", name: "Retail" },
        },
      ],
    });
    // Three bad positions: two entity types and one relation type.
    expect(countSchemaViolations(twoTriplets, CONSTRAINED)).toBe(3);
  });

  it("counts a payload the parser tolerates wrapped in prose", () => {
    // The count has to see what the rejection path sees, or the two disagree:
    // a wrapped payload is still parsed, so its violations are still real.
    const wrapped = `Here is the graph:\n${payload("PRODUCT", "SUPPLIES", "PERSON")}\nDone.`;
    expect(countSchemaViolations(wrapped, CONSTRAINED)).toBe(1);
  });
});

describe("a payload that cannot be read", () => {
  it("returns zero instead of throwing on every malformed shape", () => {
    // A bad payload is the mangled-response counter's business, never a crash
    // here: one odd chunk must not fail a document.
    for (const malformed of [
      "",
      "   \n\t",
      "not json at all",
      "{}",
      '{"triplets": "nope"}',
      '{"triplets": [null, 7]}',
      '{"triplets": [{"subject": {}}]}',
    ]) {
      expect(() => countSchemaViolations(malformed, CONSTRAINED)).not.toThrow();
      expect(countSchemaViolations(malformed, CONSTRAINED)).toBe(0);
    }
  });
});
