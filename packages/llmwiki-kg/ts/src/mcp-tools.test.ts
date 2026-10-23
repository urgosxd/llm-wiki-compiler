/**
 * @file packages/llmwiki-kg/ts/src/mcp-tools.test.ts
 * @description The MCP tool registry.
 */

import { describe, expect, it } from "vitest";
import { MCP_TOOLS, listTools } from "./mcp.js";
import { PYTHON_TOOLS } from "./mcp-harness.js";

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

  it("matches the Python Tool literals exactly, in order", () => {
    // Full deep equality over name, description and inputSchema. Order matters:
    // clients may render the list as-is, and the Python's order is the contract.
    expect(JSON.parse(JSON.stringify(listTools()))).toEqual(PYTHON_TOOLS);
  });

  it("returns a fresh array so a caller cannot mutate the registry", () => {
    const first = listTools();
    first.pop();
    expect(listTools()).toHaveLength(4);
  });

  it("omits `required` where the Python omits it", () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool.inputSchema]));
    expect(byName.get("query_stack")?.["required"]).toEqual(["query"]);
    expect(byName.get("traverse_stack")?.["required"]).toEqual(["start"]);
    // Not `[]` — the key is absent entirely for these two.
    expect(Object.hasOwn(byName.get("get_entities") ?? {}, "required")).toBe(false);
    expect(Object.hasOwn(byName.get("list_stacks") ?? {}, "required")).toBe(false);
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
