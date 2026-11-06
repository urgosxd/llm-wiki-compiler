/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/parse.test.ts
 * @description Validating an untrusted per-Stack type catalog.
 *
 * WHY THIS FILE EXISTS. The catalog arrives as jsonb (`stacks.type_catalog`),
 * which is untrusted by construction, and it becomes the vocabulary every later
 * stage classifies against. A parse that degraded silently would make a wrong
 * classification indistinguishable from a document that genuinely matches no
 * type, so each case here is a way a hand-written catalog goes wrong and must be
 * refused with an exception naming the offending field.
 *
 * The immutability case is the enforcement of S16: ingestion may not add a type,
 * so the parsed catalog must be frozen, not merely typed readonly.
 */

import { describe, expect, it } from "vitest";

import { parseTypeCatalog } from "./parse.js";
import { TypeCatalogError, type EntityTypeDef } from "./types.js";

/** A minimal well-formed catalog: two entity types, one relation, one constraint. */
const MINIMAL = {
  version: "1.0.0",
  entityTypes: [
    { name: "Role", definition: "Who acts.", examples: ["Reviewer"] },
    { name: "Process", definition: "What runs.", examples: [] },
  ],
  relationTypes: [{ name: "executes", definition: "A role runs a process.", examples: [] }],
  constraints: [{ from: "Role", relation: "executes", to: "Process" }],
  entityAliases: [{ alias: "position", canonical: "Role" }],
  relationAliases: [{ alias: "performs", canonical: "executes" }],
};

/** Builds a catalog differing from {@link MINIMAL} by one top-level field. */
function withField(field: string, value: unknown): unknown {
  return { ...MINIMAL, [field]: value };
}

describe("parseTypeCatalog", () => {
  it("keeps a well-formed catalog verbatim", () => {
    const catalog = parseTypeCatalog(MINIMAL);
    expect(catalog.version).toBe("1.0.0");
    expect(catalog.entityTypes.map((def) => def.name)).toEqual(["Role", "Process"]);
    expect(catalog.relationTypes.map((def) => def.name)).toEqual(["executes"]);
    expect(catalog.constraints).toEqual([{ from: "Role", relation: "executes", to: "Process" }]);
    expect(catalog.entityAliases).toEqual([{ alias: "position", canonical: "Role" }]);
    expect(catalog.relationAliases).toEqual([{ alias: "performs", canonical: "executes" }]);
  });

  it("defaults absent examples to an empty list and absent direction to forward", () => {
    const catalog = parseTypeCatalog({
      ...MINIMAL,
      entityTypes: [{ name: "Role", definition: "Who acts." }],
      relationTypes: [{ name: "executes", definition: "A role runs a process." }],
      constraints: [],
      entityAliases: [],
      relationAliases: [],
    });
    expect(catalog.entityTypes[0]?.examples).toEqual([]);
    expect(catalog.relationTypes[0]?.direction).toBe("forward");
  });

  it("rejects a value that is not a JSON object", () => {
    expect(() => parseTypeCatalog("catalog")).toThrow('type catalog must be a JSON object');
    expect(() => parseTypeCatalog([MINIMAL])).toThrow(TypeCatalogError);
    expect(() => parseTypeCatalog(null)).toThrow(TypeCatalogError);
  });

  it("rejects a catalog with no version", () => {
    expect(() => parseTypeCatalog({ ...MINIMAL, version: undefined })).toThrow(
      'type catalog "version" must be a non-empty string',
    );
  });

  it("rejects an entity type without a definition", () => {
    expect(() => parseTypeCatalog(withField("entityTypes", [{ name: "Role" }]))).toThrow(
      'type catalog entity type #1 must have a non-empty string "definition"',
    );
  });

  it("rejects two entity types that differ only in case", () => {
    expect(() =>
      parseTypeCatalog(
        withField("entityTypes", [
          { name: "Role", definition: "Who acts." },
          { name: "role", definition: "Who acts, again." },
        ]),
      ),
    ).toThrow('type catalog field "entityTypes" declares "role" more than once');
  });

  it("rejects an empty entity or relation type list", () => {
    expect(() => parseTypeCatalog(withField("entityTypes", []))).toThrow(
      'type catalog "entityTypes" must be a non-empty array',
    );
    expect(() => parseTypeCatalog(withField("relationTypes", []))).toThrow(
      'type catalog "relationTypes" must be a non-empty array',
    );
  });

  it("rejects an unknown relation direction", () => {
    expect(() =>
      parseTypeCatalog(
        withField("relationTypes", [
          { name: "executes", definition: "A role runs a process.", direction: "sideways" },
        ]),
      ),
    ).toThrow('type catalog relation type #1 "direction" must be "forward" or "inverse"');
  });

  it("rejects a constraint naming an undeclared entity type", () => {
    expect(() =>
      parseTypeCatalog(withField("constraints", [{ from: "Team", relation: "executes", to: "Process" }])),
    ).toThrow('type catalog constraint #1 names entity type "Team", which is not declared in "entityTypes"');
  });

  it("rejects a constraint naming an undeclared relation type", () => {
    expect(() =>
      parseTypeCatalog(withField("constraints", [{ from: "Role", relation: "approves", to: "Process" }])),
    ).toThrow('type catalog constraint #1 names relation type "approves", which is not declared in "relationTypes"');
  });

  it("rejects the same constraint triple declared twice", () => {
    const triple = { from: "Role", relation: "executes", to: "Process" };
    expect(() => parseTypeCatalog(withField("constraints", [triple, { ...triple }]))).toThrow(
      /more than once/,
    );
  });

  it("rejects an alias that would shadow a declared entity type", () => {
    expect(() =>
      parseTypeCatalog(withField("entityAliases", [{ alias: "role", canonical: "Process" }])),
    ).toThrow('type catalog alias "role" collides with the entity type "Role" it would shadow');
  });

  it("rejects an entity type declared with the reserved name", () => {
    expect(() =>
      parseTypeCatalog(
        withField("entityTypes", [
          { name: "Unclassified", definition: "Anything at all." },
          { name: "Process", definition: "What runs." },
        ]),
      ),
    ).toThrow('type catalog declares the reserved entity type "Unclassified"');
  });

  it("rejects a reserved name spelled with different case and spacing", () => {
    expect(() =>
      parseTypeCatalog(
        withField("entityTypes", [
          { name: "  UNCLASSIFIED ", definition: "Anything at all." },
          { name: "Process", definition: "What runs." },
        ]),
      ),
    ).toThrow('type catalog declares the reserved entity type "Unclassified"');
  });

  it("rejects an entity alias resolving to the reserved type", () => {
    expect(() =>
      parseTypeCatalog(withField("entityAliases", [{ alias: "misc", canonical: "unclassified" }])),
    ).toThrow('type catalog alias "misc" resolves to the reserved entity type "Unclassified"');
  });

  it("rejects an entity alias spelled as the reserved name", () => {
    expect(() =>
      parseTypeCatalog(withField("entityAliases", [{ alias: "unclassified", canonical: "Process" }])),
    ).toThrow('type catalog alias "unclassified" collides with the reserved entity type "Unclassified"');
  });

  it("rejects a malformed alias entry", () => {
    expect(() => parseTypeCatalog(withField("entityAliases", [{ alias: "position" }]))).toThrow(
      'type catalog alias #1 must have non-empty string "alias" and "canonical"',
    );
  });

  it("freezes the parsed catalog so ingestion cannot add a type", () => {
    const catalog = parseTypeCatalog(MINIMAL);
    const mutable = catalog.entityTypes as EntityTypeDef[];
    expect(() => mutable.push({ name: "Free", definition: "Added by ingestion.", examples: [] })).toThrow(
      TypeError,
    );
    expect(catalog.entityTypes.map((def) => def.name)).toEqual(["Role", "Process"]);
    expect(Object.isFrozen(catalog)).toBe(true);
  });
});
