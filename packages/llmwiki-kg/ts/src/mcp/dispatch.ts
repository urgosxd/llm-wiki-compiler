/**
 * @file packages/llmwiki-kg/ts/src/mcp/dispatch.ts
 * @description Routing a tool call by name, and the error envelopes it returns.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { MCP_TOOLS } from "./tools.js";
import {
  asArguments,
  getEntities,
  listStacks,
  queryStack,
  resolveDependencies,
  textResult,
  traverseStack,
  type McpDependencies,
} from "./handlers.js";

// ============================================================
// Dispatch
// ============================================================

/**
 * Route a tool call to the matching endpoint, mirroring `call_tool`.
 *
 * An unknown name yields the Python's `f"Unknown tool: {name}"` text as a
 * normal (non-error) result, not a protocol error. MCP clients render that as
 * tool output, which is what the reference server does.
 */
export async function callTool(
  name: string,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
  dependencies: McpDependencies = {},
): Promise<CallToolResult> {
  const deps = resolveDependencies(dependencies);
  const args = asArguments(rawArguments);

  switch (name) {
    case "query_stack":
      return queryStack(args, deps);
    case "traverse_stack":
      return traverseStack(args, deps);
    case "get_entities":
      return getEntities(args, deps);
    case "list_stacks":
      return listStacks(args, deps);
    default:
      return textResult(`Unknown tool: ${name}`);
  }
}

/** The advertised tool list, as `list_tools()` returns it. */
export function listTools(): Tool[] {
  return MCP_TOOLS.map((tool) => tool);
}
