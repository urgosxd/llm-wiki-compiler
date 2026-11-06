/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/default_catalog.test.ts
 * @description The documented example catalog this application ships.
 *
 * WHY THIS FILE EXISTS. The default catalog is the worked example the docs quote
 * and the starting declaration a Stack copies, so its content is part of the
 * product surface: five entity types, the five relations the request names, and
 * exactly five constraints. Pinning it here means an accidental edit — a dropped
 * type, a relation that lost its definition, a constraint quietly widened — fails
 * a test instead of silently changing how every document classifies.
 */

import { describe, expect, it } from "vitest";

import { defaultTypeCatalog } from "./default_catalog.js";
import { hasEntityType } from "./lookup.js";
import { UNCLASSIFIED_ENTITY_TYPE } from "./types.js";

const ENTITY_TYPES = ["Role", "Process", "Document", "Policy", "System"];

/** The five relations the request names, in canonical (`from —verb→ to`) order. */
const CONSTRAINTS = [
  { from: "Role", relation: "executes", to: "Process" },
  { from: "Role", relation: "reviews", to: "Document" },
  { from: "Process", relation: "requires", to: "Document" },
  { from: "Policy", relation: "governs", to: "Process" },
  { from: "System", relation: "supports", to: "Process" },
];

describe("defaultTypeCatalog", () => {
  it("exposes exactly the five documented entity types, each with a real definition and examples", () => {
    const catalog = defaultTypeCatalog();
    expect(catalog.entityTypes.map((def) => def.name)).toEqual(ENTITY_TYPES);
    for (const def of catalog.entityTypes) {
      expect(def.definition.length).toBeGreaterThan(20);
      expect(def.examples.length).toBeGreaterThan(0);
    }
  });

  it("exposes exactly the five documented relations with definitions and examples", () => {
    const catalog = defaultTypeCatalog();
    expect(catalog.relationTypes.map((def) => def.name)).toEqual([
      "executes",
      "reviews",
      "requires",
      "governs",
      "supports",
    ]);
    for (const def of catalog.relationTypes) {
      expect(def.definition.length).toBeGreaterThan(20);
      expect(def.examples.length).toBeGreaterThan(0);
      expect(def.direction).toBe("forward");
    }
  });

  it("permits exactly the five documented type combinations", () => {
    const catalog = defaultTypeCatalog();
    expect(catalog.constraints).toEqual(CONSTRAINTS);
  });

  it("is versioned, and the version changes are deliberate", () => {
    expect(defaultTypeCatalog().version).toBe("1.0.0");
  });

  it("does not declare the reserved unclassified type", () => {
    expect(hasEntityType(defaultTypeCatalog(), UNCLASSIFIED_ENTITY_TYPE)).toBe(false);
  });
});
