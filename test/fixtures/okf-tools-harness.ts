/**
 * @file Shared in-process harness for the MCP OKF tool.
 *
 * The OKF tool suite registers `registerOkfTools` against a fake `McpServer` that
 * just captures the tool's handler by name. The precise `ToolHandler` type means a
 * drift in the result envelope fails at tsc rather than silently at runtime.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOkfTools } from "../../packages/wiki/src/mcp/okf-tools.js";

/** A registered tool handler's call signature — drift in the result envelope fails at tsc. */
export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: true }>;

/**
 * Register the OKF tools against a fake server and return their handlers by name.
 *
 * @param root - Project root the handlers are bound to.
 * @returns The registered handlers, keyed by tool name.
 */
export function collectOkfHandlers(root: string): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fake = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => handlers.set(name, handler),
  } as unknown as McpServer;
  registerOkfTools(fake, root);
  return handlers;
}
