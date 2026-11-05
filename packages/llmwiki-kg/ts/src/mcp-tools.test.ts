/**
 * @file packages/llmwiki-kg/ts/src/mcp-tools.test.ts
 * @description The MCP tool registry.
 */

import { describe, expect, it } from "vitest";
import { MCP_TOOLS, listTools } from "./mcp.js";

describe("listTools", () => {
  it("advertises exactly the four Python tools, including list_stacks", () => {
    // The Python module docstring claims "Three tools exposed" and omits
    // list_stacks, but `list_tools()` contains four `Tool(...)` calls and
    // `call_tool` has four dispatch branches. The registry is the contract.
    // This test exists so a future reader cannot "repair" four back to three.
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "query_stack",
      "traverse_stack",
      "get_entities",
      "list_stacks",
    ]);
  });

  it("advertises four tools even though the Python docstring says three", () => {
    // Guards the exact staleness documented in the module header: the count
    // asserted here is the number of `Tool(...)` literals in the source, and it
    // disagrees with the prose. Do not align these by editing the code.
    expect(MCP_TOOLS).toHaveLength(4);
    expect(MCP_TOOLS.filter((tool) => tool.name === "list_stacks")).toHaveLength(1);
  });

  it("returns a fresh array so a caller cannot mutate the registry", () => {
    const first = listTools();
    first.pop();
    expect(listTools()).toHaveLength(4);
  });

  it("requires stackId on all three graph tools", () => {
    // The Stack is only ever the argument: no default and no fallback, so the
    // schema names it instead of letting a call arrive without one.
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool.inputSchema]));
    expect(byName.get("query_stack")?.["required"]).toEqual(["query", "stackId"]);
    expect(byName.get("traverse_stack")?.["required"]).toEqual(["start", "stackId"]);
    expect(byName.get("get_entities")?.["required"]).toEqual(["stackId"]);
  });

  it("declares no `required` on list_stacks", () => {
    // `list_stacks` discovers Stacks and takes no Stack argument, so it declares
    // no `required`. Not `[]` — the key is absent entirely, a different schema.
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool.inputSchema]));
    expect(Object.hasOwn(byName.get("list_stacks") ?? {}, "required")).toBe(false);
  });

  it("declares the shared list_stacks input schema: limit and stackId, nothing required", () => {
    const list = MCP_TOOLS.find((tool) => tool.name === "list_stacks");
    const properties = (list?.inputSchema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string; minimum?: number; maximum?: number }
    >;
    // The same two arguments the wiki dimension declares, in the same order (S3).
    expect(Object.keys(properties)).toEqual(["limit", "stackId"]);
    expect(properties["limit"]).toEqual({
      description: "How many Stacks to return (default 50, max 200).",
      type: "integer",
      minimum: 1,
      maximum: 200,
    });
    expect(properties["stackId"]?.type).toBe("string");
    // `stackId` does NOT narrow the listing: it only decides which entry is current.
    expect(properties["stackId"]?.description ?? "").toContain("does NOT narrow the listing");
    // The exemption survives the unification: no `required` key at all.
    expect(Object.hasOwn(list?.inputSchema ?? {}, "required")).toBe(false);
  });

  it("keeps the numeric schema defaults as the Python declares them", () => {
    // The defaults are part of the advertised schema an LLM client reads, so
    // they are pinned by value rather than merely by presence.
    const schemas = MCP_TOOLS.map((tool) => tool.inputSchema);
    expect(schemas[0]?.properties?.["max_entities"]).toEqual({
      type: "integer",
      description: "Maximum number of entities to return (default 8)",
      default: 8,
    });
    expect(schemas[1]?.properties?.["max_depth"]).toEqual({
      type: "integer",
      description: "Maximum hops from the starting entity (default 2)",
      default: 2,
    });
    expect(schemas[2]?.properties?.["min_confidence"]).toEqual({
      type: "number",
      description: "Minimum confidence (0.0-1.0)",
      default: 0.0,
    });
    expect(schemas[2]?.properties?.["limit"]).toEqual({
      type: "integer",
      description: "Maximum entities to return (default 100, max 1000)",
      default: 100,
    });
  });
});
