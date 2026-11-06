/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/contract.test.ts
 * @description The extraction contract: open in its schema, orienting in its text.
 *
 * WHY THIS FILE EXISTS. Openness that lives in a provider flag is openness this
 * package does not own: the day a gateway honours an `enum` the catalog was
 * rendered into, a supported candidate outside the catalog would be refused
 * before any code of ours saw it. Every case below asserts that the freedom is in
 * the schema itself and that the catalog only ever arrives as guidance.
 */

import { describe, expect, it } from "vitest";

import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { buildOpenExtractionContract } from "./contract.js";
import type { ToolDefinition } from "../llm/tool-call.js";

/** Reads one `$defs` property field from a tool schema. */
function fieldOf(tool: ToolDefinition, definition: string, field: string): Record<string, unknown> {
  const parameters = tool.parameters as {
    readonly $defs: Record<string, { readonly properties: Record<string, Record<string, unknown>> }>;
  };
  return parameters.$defs[definition]!.properties[field]!;
}

describe("buildOpenExtractionContract", () => {
  it("declares proposed types and predicates as free strings, with no enum even when a catalog is supplied", () => {
    const contract = buildOpenExtractionContract({ catalog: defaultTypeCatalog() });
    const proposedType = fieldOf(contract.tool, "EntityCandidate", "type");
    const predicate = fieldOf(contract.tool, "RelationCandidate", "predicate");
    expect(proposedType["enum"]).toBeUndefined();
    expect(proposedType["type"]).toEqual(["string", "null"]);
    expect(predicate["enum"]).toBeUndefined();
    expect(predicate["pattern"]).toBeUndefined();
    expect(predicate["type"]).toBe("string");
  });

  it("passes the catalog as orientation lines carrying definitions and examples", () => {
    const contract = buildOpenExtractionContract({ catalog: defaultTypeCatalog() });
    const orientation = contract.orientation.join("\n");
    expect(orientation).toContain("Role");
    expect(orientation).toContain("executes");
    expect(contract.instruction).toContain(orientation);
  });

  it("tells the model an out-of-catalog candidate must still be returned", () => {
    const contract = buildOpenExtractionContract({ catalog: defaultTypeCatalog() });
    expect(contract.instruction).toMatch(/outside the catalog/i);
    expect(contract.instruction).toMatch(/still be reported/i);
  });

  it("keeps the same open schema when no catalog is configured at all", () => {
    const contract = buildOpenExtractionContract();
    expect(contract.orientation).toEqual([]);
    expect(fieldOf(contract.tool, "EntityCandidate", "type")["enum"]).toBeUndefined();
    expect(fieldOf(contract.tool, "RelationCandidate", "predicate")["enum"]).toBeUndefined();
  });

  it("asks for entity candidates that take part in no relation, and never for completeness", () => {
    const contract = buildOpenExtractionContract({ catalog: defaultTypeCatalog() });
    expect(contract.tool.parameters).toHaveProperty("properties.entities");
    expect(contract.instruction).toMatch(/no relation/i);
    expect(contract.instruction).toMatch(/partial result is expected/i);
    expect(contract.instruction).not.toMatch(/all (the )?knowledge/i);
  });

  it("names the per-chunk cap in the instruction so the model is not cut off silently", () => {
    expect(buildOpenExtractionContract({ maxCandidatesPerChunk: 7 }).instruction).toContain("7");
    expect(buildOpenExtractionContract().instruction).toContain("50");
  });
});
