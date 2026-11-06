/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/lookup.test.ts
 * @description Resolving proposed type labels against a parsed catalog.
 *
 * WHY THIS FILE EXISTS. Classification starts from a label an extractor
 * proposed, which is a free string: `role`, `Role `, `position`. Resolving it is
 * the whole difference between a classified entity and a free one, so the
 * negative case matters as much as the positive one. An unresolvable label must
 * come back empty — never a fallback type, never `Concept`, never the first
 * entry — because a wrong canonical type is worse than an honest free entity.
 */

import { describe, expect, it } from "vitest";

import { hasEntityType, hasRelationType, relationConstraintsFor, resolveEntityType, resolveRelationType } from "./lookup.js";
import { parseTypeCatalog } from "./parse.js";
import type { TypeCatalog } from "./types.js";

/** A two-type, two-relation catalog with one declared constraint. */
const CATALOG: TypeCatalog = parseTypeCatalog({
  version: "1.0.0",
  entityTypes: [
    { name: "Role", definition: "Who acts.", examples: ["Reviewer"] },
    { name: "Process", definition: "What runs.", examples: ["Change management"] },
  ],
  relationTypes: [
    { name: "executes", definition: "A role runs a process.", examples: [] },
    { name: "mentions", definition: "A free-standing reference.", examples: [] },
  ],
  constraints: [{ from: "Role", relation: "executes", to: "Process" }],
  entityAliases: [{ alias: "position", canonical: "Role" }],
  relationAliases: [{ alias: "performs", canonical: "executes" }],
});

describe("resolveEntityType", () => {
  it("resolves an exact canonical name to its definition", () => {
    const resolved = resolveEntityType(CATALOG, "Role");
    expect(resolved?.name).toBe("Role");
    expect(resolved?.definition).toBe("Who acts.");
  });

  it("resolves an alias to the canonical definition", () => {
    expect(resolveEntityType(CATALOG, "position")?.name).toBe("Role");
  });

  it("resolves case, surrounding space and hyphen variants", () => {
    expect(resolveEntityType(CATALOG, "  ROLE ")?.name).toBe("Role");
    expect(resolveEntityType(CATALOG, "Position")?.name).toBe("Role");
  });

  it("returns undefined for an unresolvable label instead of a fallback type", () => {
    expect(resolveEntityType(CATALOG, "Team")).toBeUndefined();
    expect(resolveEntityType(CATALOG, "")).toBeUndefined();
    expect(hasEntityType(CATALOG, "Team")).toBe(false);
  });
});

describe("resolveRelationType", () => {
  it("resolves a canonical name and an alias", () => {
    expect(resolveRelationType(CATALOG, "executes")?.name).toBe("executes");
    expect(resolveRelationType(CATALOG, "performs")?.name).toBe("executes");
  });

  it("returns undefined for a predicate the catalog does not declare", () => {
    expect(resolveRelationType(CATALOG, "deja sin efecto")).toBeUndefined();
    expect(hasRelationType(CATALOG, "deja sin efecto")).toBe(false);
  });
});

describe("relationConstraintsFor", () => {
  it("returns the declared triples for a canonical name and for its alias", () => {
    const declared = [{ from: "Role", relation: "executes", to: "Process" }];
    expect(relationConstraintsFor(CATALOG, "executes")).toEqual(declared);
    expect(relationConstraintsFor(CATALOG, "performs")).toEqual(declared);
  });

  it("returns no constraint for a declared relation that declares none", () => {
    expect(hasRelationType(CATALOG, "mentions")).toBe(true);
    expect(relationConstraintsFor(CATALOG, "mentions")).toEqual([]);
  });

  it("returns no constraint for a predicate outside the catalog", () => {
    expect(relationConstraintsFor(CATALOG, "invalidates")).toEqual([]);
  });
});
