/**
 * @file packages/llmwiki-kg/ts/src/core/ontology.test.ts
 * @description Loading and validating a declarative knowledge-graph ontology.
 *
 * WHY THIS FILE EXISTS. The extraction prompt has always *suggested* type lists
 * to the model and then accepted whatever came back, because
 * `SchemaLLMPathExtractor` runs with `strict=False`. A caller-supplied ontology
 * turns that suggestion into a contract, and a contract with a malformed
 * hierarchy is worse than no contract: it either rejects good triplets or
 * accepts bad ones while claiming to enforce something.
 *
 * So the validator is tested before the enforcement exists. Each case here is a
 * way a hand-written JSON file goes wrong.
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadOntology, OntologyError, validateOntology } from "./ontology.js";

/**
 * Fixture path resolved from this file, not from the process cwd.
 *
 * Vitest runs with the repository root as cwd, so a bare relative fixture path
 * resolves against the root rather than against this directory and the test
 * passes or fails depending on how it was launched.
 */
const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, FIXTURES));

/** A minimal well-formed ontology. */
const MINIMAL = {
  entityTypes: ["ORGANIZATION", "COMPANY"],
  relationshipTypes: ["SUPPLIES"],
  subtypes: [{ child: "COMPANY", parent: "ORGANIZATION" }],
};

describe("validateOntology", () => {
  it("accepts a well-formed ontology", () => {
    const ontology = validateOntology(MINIMAL);
    expect(ontology.entityTypes).toEqual(["ORGANIZATION", "COMPANY"]);
    expect(ontology.relationshipTypes).toEqual(["SUPPLIES"]);
    expect(ontology.subtypes).toEqual([{ child: "COMPANY", parent: "ORGANIZATION" }]);
  });

  it("treats subtypes as optional", () => {
    const ontology = validateOntology({
      entityTypes: ["COMPANY"],
      relationshipTypes: ["SUPPLIES"],
    });
    expect(ontology.subtypes).toEqual([]);
  });

  it("rejects an ontology with no entity types", () => {
    expect(() => validateOntology({ entityTypes: [], relationshipTypes: ["SUPPLIES"] })).toThrow(
      OntologyError,
    );
  });

  it("rejects an ontology with no relationship types", () => {
    expect(() => validateOntology({ entityTypes: ["COMPANY"], relationshipTypes: [] })).toThrow(
      OntologyError,
    );
  });

  it("rejects a subtype whose parent is undeclared", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["COMPANY"],
        relationshipTypes: ["SUPPLIES"],
        subtypes: [{ child: "COMPANY", parent: "ORGANIZATION" }],
      }),
    ).toThrow(/ORGANIZATION/);
  });

  it("rejects a subtype whose child is undeclared", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["ORGANIZATION"],
        relationshipTypes: ["SUPPLIES"],
        subtypes: [{ child: "COMPANY", parent: "ORGANIZATION" }],
      }),
    ).toThrow(/COMPANY/);
  });

  it("rejects a subtype cycle", () => {
    expect(() =>
      validateOntology({
        entityTypes: ["ALPHA", "BETA"],
        relationshipTypes: ["SUPPLIES"],
        subtypes: [
          { child: "ALPHA", parent: "BETA" },
          { child: "BETA", parent: "ALPHA" },
        ],
      }),
    ).toThrow(/cycle/i);
  });
});

describe("loadOntology", () => {
  it("loads and validates a JSON file from disk", async () => {
    const ontology = await loadOntology(fixture("kg-ontology-minimal.json"));
    expect(ontology.entityTypes).toContain("COMPANY");
  });

  it("reports a missing file as an ontology error, not a raw fs error", async () => {
    await expect(loadOntology(fixture("does-not-exist.json"))).rejects.toThrow(OntologyError);
  });
});
