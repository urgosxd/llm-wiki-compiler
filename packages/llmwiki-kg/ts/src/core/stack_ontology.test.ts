/**
 * @file packages/llmwiki-kg/ts/src/core/stack_ontology.test.ts
 * @description Reading a Stack's stored ontology, and filling one in.
 *
 * WHY THIS FILE EXISTS. The HTTP surface cannot carry an ontology: the oracle's
 * `StackCreate`, `StackUpdate` and `StackResponse` have no such field, and
 * `stacks.ts` repeats Python's `_STACK_COLUMNS` verbatim because response key
 * order is contractual. So the column has to be populated another way, and the
 * two operations that matter are "read whatever is stored" and "store a reviewed
 * declaration".
 *
 * The load-bearing rule is that NULL MEANS THE ORACLE BEHAVIOUR, not an empty
 * ontology. `validateOntology` rejects an empty declaration, so coercing null to
 * `{}` would put every unconfigured Stack into enforcement mode and start
 * rejecting triplets it accepts today.
 */

import { describe, expect, it } from "vitest";

import { readStackOntology, toStoredOntology } from "./stack_ontology.js";

/** A Stack row carrying a declaration. */
const STORED = {
  entityTypes: ["ORGANIZATION", "COMPANY"],
  relationshipTypes: ["SUPPLIES"],
  subtypes: [{ child: "COMPANY", parent: "ORGANIZATION" }],
};

describe("readStackOntology", () => {
  it("returns undefined for a null column, meaning oracle behaviour", () => {
    expect(readStackOntology(null)).toBeUndefined();
  });

  it("returns undefined for an absent column", () => {
    expect(readStackOntology(undefined)).toBeUndefined();
  });

  it("validates and returns a stored declaration", () => {
    const ontology = readStackOntology(STORED);
    expect(ontology?.entityTypes).toEqual(["ORGANIZATION", "COMPANY"]);
    expect(ontology?.subtypes).toHaveLength(1);
  });

  it("fails loudly on a malformed declaration instead of admitting everything", () => {
    expect(() => readStackOntology({ entityTypes: [] })).toThrow(/malformed|entityTypes/i);
  });

  it("normalises stored type names the same way the parser will", () => {
    const ontology = readStackOntology({
      entityTypes: ["organization", "Company"],
      relationshipTypes: ["supplies"],
    });
    expect(ontology?.entityTypes).toEqual(["ORGANIZATION", "COMPANY"]);
  });
});

describe("toStoredOntology", () => {
  it("produces a JSON-storable object with normalised names", () => {
    const stored = toStoredOntology({
      entityTypes: ["organization"],
      relationshipTypes: ["supplies"],
    });
    expect(stored).toEqual({
      entityTypes: ["ORGANIZATION"],
      relationshipTypes: ["SUPPLIES"],
      subtypes: [],
      relationships: [],
    });
  });

  it("refuses to produce a declaration the reader would reject", () => {
    expect(() => toStoredOntology({ entityTypes: [], relationshipTypes: ["supplies"] })).toThrow();
  });

  it("round-trips through the reader unchanged", () => {
    const stored = toStoredOntology(STORED);
    const read = readStackOntology(stored);
    expect(read?.entityTypes).toEqual(["ORGANIZATION", "COMPANY"]);
    expect(read?.subtypes).toEqual([{ child: "COMPANY", parent: "ORGANIZATION" }]);
  });
});
