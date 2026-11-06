/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/stack-catalog.test.ts
 * @description The derivation of a catalog from a legacy Stack declaration, and the
 * version string that identifies it (S14, S16, S43).
 *
 * WHY THIS FILE EXISTS. A Stack that declared its vocabulary only in the legacy
 * `stacks.ontology` column used to be classified against the SHIPPED default, so a
 * type the Stack itself declared (`COMPANY`) was compared against a vocabulary that
 * never named it — its own existing knowledge was mislabelled by its own graph. The
 * derivation here is the fix, and the four facts that can rot silently are pinned:
 *
 * 1. the declared types BECOME catalog types, both namespaces;
 * 2. the declaration's `domains`/`ranges` become catalog constraints, and an
 *    unconstrained relationship stays unconstrained instead of being enumerated;
 * 3. every generated definition says so, so a declared definition and a generated
 *    one are never confused;
 * 4. the version is derived from the vocabulary, so two runs agree and a changed
 *    declaration does not.
 *
 * Pure: no database, no provider, no clock.
 */

import { describe, expect, it } from "vitest";

import { catalogFromOntology, UNDEFINED_TYPE_MARKER } from "./stack-catalog.js";

/** The legacy declaration shape a Stack carries in `stacks.ontology`. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS", "SUPPLIES"],
  subtypes: [{ child: "COMPANY", parent: "PERSON" }],
  relationships: [
    { type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] },
    { type: "SUPPLIES", domains: ["COMPANY"] },
  ],
};

describe("deriving a catalog from a Stack ontology", () => {
  it("turns both declared type lists into catalog types (S14)", () => {
    const catalog = catalogFromOntology(DECLARATION);

    expect(catalog.entityTypes.map((type) => type.name)).toEqual(["COMPANY", "PERSON"]);
    expect(catalog.relationTypes.map((type) => type.name)).toEqual(["EMPLOYS", "SUPPLIES"]);
    // Nothing else is invented: no aliases, no examples.
    expect(catalog.entityAliases).toEqual([]);
    expect(catalog.relationAliases).toEqual([]);
    expect(catalog.relationTypes.every((type) => type.examples.length === 0)).toBe(true);
  });

  it("marks every generated definition as generated", () => {
    const catalog = catalogFromOntology(DECLARATION);

    for (const type of [...catalog.entityTypes, ...catalog.relationTypes]) {
      // A catalog requires a definition and the legacy column never carries one, so
      // the generated sentence states what is known and no more (S14).
      expect(type.definition.startsWith(UNDEFINED_TYPE_MARKER)).toBe(true);
      expect(type.definition).toContain(`"${type.name}"`);
    }
  });

  it("expands declared domains and ranges into permitted combinations", () => {
    const catalog = catalogFromOntology({
      ...DECLARATION,
      relationships: [{ type: "EMPLOYS", domains: ["COMPANY", "PERSON"], ranges: ["PERSON"] }],
    });

    expect(catalog.constraints).toEqual([
      { from: "COMPANY", relation: "EMPLOYS", to: "PERSON" },
      { from: "PERSON", relation: "EMPLOYS", to: "PERSON" },
    ]);
  });

  it("leaves a relationship without both lists unconstrained", () => {
    const catalog = catalogFromOntology(DECLARATION);

    // `SUPPLIES` declares a domain and no range, i.e. "any declared type". A catalog
    // cannot express that, and enumerating the pairs would turn a permission into a
    // rule that then reports conflicts nobody declared.
    expect(catalog.constraints).toEqual([{ from: "COMPANY", relation: "EMPLOYS", to: "PERSON" }]);
  });

  it("derives the version from the vocabulary, not from the clock (S43)", () => {
    const first = catalogFromOntology(DECLARATION);
    const second = catalogFromOntology(DECLARATION);
    const changed = catalogFromOntology({ ...DECLARATION, entityTypes: ["COMPANY", "PERSON", "TEAM"] });

    expect(first.version).toBe(second.version);
    expect(first.version).not.toBe(changed.version);
    // It never collides with the shipped default's version, so a row's
    // `catalog_version` always says which vocabulary produced the decision.
    expect(first.version).not.toBe("1.0.0");
    expect(first.version.startsWith("ontology-derived:")).toBe(true);
  });

  it("returns a frozen catalog and leaves the declaration untouched (S16)", () => {
    const declaration = structuredClone(DECLARATION);
    const catalog = catalogFromOntology(declaration);

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(() => {
      (catalog.entityTypes as unknown as unknown[]).push({});
    }).toThrow();
    // Ingestion must never write a catalog, so the input is read, never modified.
    expect(declaration).toEqual(DECLARATION);
  });

  it("refuses a declaration that names no types at all", () => {
    // "Admits nothing" is a declaration mistake, not a configured empty vocabulary,
    // and it must surface as an error rather than as a catalog nobody can match.
    expect(() => catalogFromOntology({ entityTypes: [], relationshipTypes: ["EMPLOYS"] })).toThrow();
    expect(() => catalogFromOntology({ entityTypes: ["COMPANY"] })).toThrow();
  });
});
