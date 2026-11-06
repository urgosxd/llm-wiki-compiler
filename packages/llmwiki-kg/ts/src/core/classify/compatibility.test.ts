/**
 * @file packages/llmwiki-kg/ts/src/core/classify/compatibility.test.ts
 * @description Endpoint-type compatibility: the third axis, and the one that never abstains.
 *
 * WHY THIS FILE EXISTS. S34 names three answers, not two: `compatible`, `conflict`,
 * and `indeterminate` for the case where an endpoint has no canonical type. The
 * dangerous collapse is treating "we cannot tell" as either of the decided answers,
 * or treating a conflict as a reason to drop a fact. The last case here pins the
 * `inverse` reading: constraints are declared in canonical order, so a relation
 * whose verb reads backwards must have its endpoints swapped before the check.
 */

import { describe, expect, it } from "vitest";

import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { parseTypeCatalog } from "../catalog/parse.js";
import { assessRelationCompatibility } from "./compatibility.js";

const CATALOG = defaultTypeCatalog();

describe("assessRelationCompatibility — the three answers of S34", () => {
  it("reports compatible for a declared triple", () => {
    const state = assessRelationCompatibility({
      catalog: CATALOG,
      canonicalRelationType: "executes",
      fromCanonicalType: "Role",
      toCanonicalType: "Process",
    });
    expect(state).toBe("compatible");
  });

  it("reports conflict for known types the catalog does not permit", () => {
    const state = assessRelationCompatibility({
      catalog: CATALOG,
      canonicalRelationType: "executes",
      fromCanonicalType: "Process",
      toCanonicalType: "Role",
    });
    expect(state).toBe("conflict");
  });

  it("reports indeterminate when an endpoint has no canonical type", () => {
    const freeEndpoint = assessRelationCompatibility({
      catalog: CATALOG,
      canonicalRelationType: "executes",
      fromCanonicalType: "Role",
      toCanonicalType: null,
    });
    expect(freeEndpoint).toBe("indeterminate");
  });

  it("reports indeterminate when the relation itself has no canonical type", () => {
    const freeRelation = assessRelationCompatibility({
      catalog: CATALOG,
      canonicalRelationType: null,
      fromCanonicalType: "Role",
      toCanonicalType: "Process",
    });
    expect(freeRelation).toBe("indeterminate");
  });

  it("reports compatible for a declared relation that declares no constraint", () => {
    const unconstrained = parseTypeCatalog({
      version: "1.0.0",
      entityTypes: [{ name: "Role", definition: "Who acts." }],
      relationTypes: [{ name: "touches", definition: "Any loose contact." }],
    });
    const state = assessRelationCompatibility({
      catalog: unconstrained,
      canonicalRelationType: "touches",
      fromCanonicalType: "Role",
      toCanonicalType: "Role",
    });
    expect(state).toBe("compatible");
  });
});

describe("assessRelationCompatibility — reading direction", () => {
  /** A catalog whose one relation reads from object to subject. */
  const INVERSE = parseTypeCatalog({
    version: "1.0.0",
    entityTypes: [
      { name: "Role", definition: "Who acts." },
      { name: "Process", definition: "What runs." },
    ],
    relationTypes: [{ name: "is executed by", definition: "Passive phrasing of executes.", direction: "inverse" }],
    constraints: [{ from: "Role", relation: "is executed by", to: "Process" }],
  });

  it("swaps the endpoints of an inverse relation before consulting the constraints", () => {
    const passive = assessRelationCompatibility({
      catalog: INVERSE,
      canonicalRelationType: "is executed by",
      fromCanonicalType: "Process",
      toCanonicalType: "Role",
    });
    const activeReading = assessRelationCompatibility({
      catalog: INVERSE,
      canonicalRelationType: "is executed by",
      fromCanonicalType: "Role",
      toCanonicalType: "Process",
    });
    expect(passive).toBe("compatible");
    expect(activeReading).toBe("conflict");
  });
});
