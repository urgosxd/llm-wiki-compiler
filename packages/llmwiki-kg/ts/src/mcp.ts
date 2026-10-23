/**
 * @file packages/llmwiki-kg/ts/src/mcp.ts
 * @description MCP server wrapping the AKS query endpoints as tools — public surface.
 *
 * Split into `src/mcp/` to keep each file under the project's size limits. This
 * module stays the single import site, so the standalone server entry point and
 * the tests are unaffected:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Base URL + auth headers | `mcp/config.ts` |
 * | Tool registry | `mcp/tools.ts` |
 * | Python number formatting | `mcp/py-format.ts` |
 * | Query-string encoding | `mcp/query-string.ts` |
 * | JSON narrowing | `mcp/narrow.ts` |
 * | Response formatting | `mcp/format.ts` |
 * | Tool implementations | `mcp/handlers.ts` |
 * | Tool-call dispatch | `mcp/dispatch.ts` |
 * | Server construction | `mcp/server.ts` |
 */

export { AKS_API_KEY, AKS_BASE_URL, authHeaders } from "./mcp/config.js";
export { MCP_TOOLS } from "./mcp/tools.js";
export { formatFixed2 } from "./mcp/py-format.js";
export { encodeQuery, floatParam, intParam, pyFloatToString, quotePlus, rawParam } from "./mcp/query-string.js";
export type { QueryValue } from "./mcp/query-string.js";
export {
  formatContextResponse,
  formatEntitiesResponse,
  formatStacksResponse,
  formatTraverseResponse,
} from "./mcp/format.js";
export { createMcpServer } from "./mcp/server.js";
export { callTool, listTools } from "./mcp/dispatch.js";
export type { FetchLike, McpDependencies } from "./mcp/handlers.js";
