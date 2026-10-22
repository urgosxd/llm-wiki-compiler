/**
 * @file packages/llmwiki-kg/ts/src/mcp/server.ts
 * @description Constructing the MCP server and binding it to stdio.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { callTool, listTools } from "./dispatch.js";
import type { McpDependencies } from "./handlers.js";

// ============================================================
// Server construction
// ============================================================

/**
 * Build the MCP `Server` with both request handlers registered.
 *
 * Exported so tests can drive a real protocol handshake over the SDK's
 * in-memory transport instead of spawning a process or opening a socket.
 */
export function createMcpServer(dependencies: McpDependencies = {}): Server {
  const server = new Server(
    { name: "aks-reference-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments, dependencies),
  );

  return server;
}

/**
 * Run the MCP server over stdio for local clients, like `run_stdio()`.
 *
 * stdio only: no port is bound, so this cannot collide with an AKS API
 * instance listening on 8000.
 */
export async function runStdio(dependencies: McpDependencies = {}): Promise<void> {
  const server = createMcpServer(dependencies);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Entry point, mirroring the Python's `if __name__ == "__main__": main()`.
 *
 * Deliberately not auto-invoked on import: this module is imported by tests
 * and by any launcher that wants `createMcpServer` without stdio. The Python
 * guards its `main()` the same way, so importing `app.mcp_server` never starts
 * a server there either. See `dist/mcp.js` executed directly via
 * `node -e 'import("./dist/mcp.js").then((m) => m.main())'` or a launcher script.
 *
 * A rejected startup is a hard exit, as in Python: a stdio MCP server that
 * fails to bind has no channel to report the failure on, only stderr and a
 * non-zero status for the client that spawned it.
 */
export async function main(): Promise<void> {
  try {
    await runStdio();
  } catch (error) {
    console.error("MCP server failed to start:", error);
    process.exitCode = 1;
  }
}
