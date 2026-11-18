/**
 * @file packages/llmwiki-kg/ts/src/mcp/union.ts
 * @description Registering the graph tools on a server another dimension already owns.
 *
 * ## Why this module exists
 *
 * `mcp/server.ts` builds the STANDALONE graph server: the low-level SDK `Server` whose
 * `tools/list` answers {@link MCP_TOOLS} verbatim. That is the right shape for the image
 * that serves this package alone, and it is the wrong shape for a surface that also serves
 * the wiki tools, because the wiki tools are registered on the high-level `McpServer` and
 * two request handlers for `tools/list` cannot both be installed on one server.
 *
 * So the graph tools travel as a REGISTRATION SEAM instead: {@link registerKgToolsOn} adds
 * them to a server somebody else built, and the tools themselves are the same definitions —
 * read from {@link MCP_TOOLS}, never restated. Nothing about the standalone server changes,
 * and the graph package still learns nothing about the wiki.
 *
 * ## Why the schemas are converted rather than hand-written
 *
 * The high-level `McpServer` takes Zod schemas and derives the advertised JSON Schema from
 * them, while this package's registry is already JSON Schema (that is what the low-level
 * `Server` publishes). Hand-writing a second, Zod copy of each input contract would be a
 * second source of truth for the same API, and the copies would drift the first time one
 * side changed. {@link registerKgToolsOn} converts each tool's OWN `inputSchema` instead, so
 * `MCP_TOOLS` stays the one declaration: the union surface advertises what the standalone
 * surface advertises.
 *
 * ## Why the exclusion is a named constant
 *
 * `list_stacks` is the one registry name another dimension also registers, and a duplicated
 * name in one `tools/list` is a defect: the client cannot say which implementation answers.
 * On a shared surface the WIKI implementation answers — it reads the wiki stack store the
 * existing client already sees, and it does not need this package's REST surface to be up.
 * The exclusion is therefore stated here, once, by name, so the union's inventory can never
 * come to depend on registration order. The tool itself stays in {@link MCP_TOOLS} and stays
 * served by the standalone graph server: only the shared surface yields it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fromJSONSchema } from "zod";

import { callTool } from "./dispatch.js";
import type { McpDependencies } from "./handlers.js";
import { MCP_TOOLS } from "./tools.js";

/**
 * The registry name this package does NOT bring to a shared surface.
 *
 * A decision, not an omission: see this file's header. It is also the reason a union
 * surface advertises 17 names instead of 18 — one `list_stacks`, answered by the wiki.
 */
export const UNION_YIELDS_TO_WIKI = "list_stacks";

/**
 * The tools a shared surface gains: everything in the registry except the yielded name.
 *
 * Derived from {@link MCP_TOOLS} rather than listed again, so a tool added to the registry
 * joins the shared surface by default and the two inventories cannot disagree. Order is the
 * registry's; a client sorts for itself.
 */
export const KG_UNION_TOOLS: readonly Tool[] = MCP_TOOLS.filter(
  (tool) => tool.name !== UNION_YIELDS_TO_WIKI,
);

/**
 * One tool's advertised JSON Schema, in the shape the Zod converter accepts.
 *
 * The cast is the boundary between two declarations of the same thing: `Tool.inputSchema`
 * is the MCP protocol's object-schema type, while the converter takes the wider
 * `JSONSchema` union. The value is the registry's own schema either way, so this narrows a
 * type and never rewrites a contract.
 *
 * @param tool - One registry entry.
 * @returns The schema to convert.
 */
function advertisedSchemaOf(tool: Tool): Parameters<typeof fromJSONSchema>[0] {
  return tool.inputSchema as Parameters<typeof fromJSONSchema>[0];
}

/**
 * Register the graph tools on an existing MCP server.
 *
 * Every call is dispatched through the SAME `callTool` the standalone server uses, so a tool
 * answers identically on both surfaces. Nothing is resolved here: registration converts
 * schemas and installs handlers, which touches no database, no config and no Stack — that is
 * what lets a composed server start in a deployment that has none, and what keeps a graph
 * tool's failure confined to the call that made it.
 *
 * @param server - The server to add the tools to; it must not be connected yet.
 * @param dependencies - Where the tools send their HTTP calls, and with which key. Defaults
 *   come from this package's MCP config, exactly as they do for the standalone server.
 */
export function registerKgToolsOn(
  server: McpServer,
  dependencies: McpDependencies = {},
): void {
  for (const tool of KG_UNION_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description ?? "",
        inputSchema: fromJSONSchema(advertisedSchemaOf(tool)),
      },
      (args: unknown): Promise<CallToolResult> =>
        callTool(tool.name, args as Record<string, unknown> | undefined, dependencies),
    );
  }
}
