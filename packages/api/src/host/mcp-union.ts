/**
 * @file packages/api/src/host/mcp-union.ts
 * @description The ONE MCP surface this image serves: the wiki tools plus the graph tools.
 *
 * ## Why the composition lives here and nowhere else
 *
 * Both dimensions have to be named in the same module to be composed, and the topology
 * permits exactly one package to name both: `api → wiki` and `api → kg` are legal,
 * `wiki → kg` is forbidden in both directions. So this module is the only honest home for
 * the union — the wiki package must not learn that a graph exists, and the graph package
 * must not import a wiki type. Each dimension contributes its own registration through its
 * own public entry (`createWikiMcpServer`, `registerKgToolsOn`); this module only joins
 * them.
 *
 * ## Why both transports go through this composition
 *
 * An image that advertises 17 tools over stdio and 14 over HTTP is the defect this feature
 * exists to close, one transport at a time. `serve` (stdio) and the host's `/mcp`
 * (streamable HTTP) therefore both start from {@link createUnionMcpServer}: one function,
 * two transports, so a tool added here cannot reach one of them and miss the other.
 *
 * ## `list_stacks` is answered by the wiki, and that is a decision
 *
 * Both surfaces register a tool of that name. A duplicated name in one `tools/list` is a
 * defect — the client cannot tell which implementation answers — so the union excludes the
 * graph one, explicitly, via `UNION_YIELDS_TO_WIKI`. The wiki implementation reads the wiki
 * stack store the existing client already sees and needs no REST surface to be up; the
 * graph one would add an HTTP hop to `${baseUrl}/stacks` on every listing. The graph tool
 * stays registered on the standalone graph server; only this surface yields it.
 *
 * ## Why starting the composed server touches nothing
 *
 * Registering the graph tools converts schemas and installs handlers. It opens no database
 * connection, resolves no Stack and reads no config beyond the MCP config module's own
 * load-time snapshot — so the union boots in a deployment with no database at all, which is
 * how the published image starts. A tool that needs a backend fails per CALL, and it fails
 * only its own call: the wiki tools share the server but not the failure.
 *
 * ## Where the graph tools send their requests
 *
 * They are HTTP clients of a graph API (`mcp/handlers.ts`), and in the image's `host` mode
 * that API is the listener this very process binds — `startHost` mounts `createApp()` on it.
 * {@link selfServedKgBaseUrl} therefore points them at that listener when no `AKS_BASE_URL`
 * is configured, which is what makes the shipped single image answer a graph tool instead of
 * dialing a port nothing listens on. A deployment that names `AKS_BASE_URL` keeps its own
 * answer: this never overrides a configured base URL.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requireDimensionsPort } from "@repo/foundation";
import { registerKgToolsOn } from "@repo/kg/mcp";
import { createWikiMcpServer, type ServerOptions } from "@repo/wiki/mcp";
import { INGEST_DIMENSIONS } from "@repo/wiki/ingest-service";

import type { McpBoundAddress } from "./server.js";

/** The variable that overrides where the graph tools send their HTTP requests. */
const KG_BASE_URL_ENV_VAR = "AKS_BASE_URL";

/**
 * What the union needs: the wiki server's own options, plus where the graph tools should call.
 *
 * `kgBaseUrl` is OPTIONAL on purpose. Absent means "let the graph MCP config decide", which
 * is exactly what the standalone stdio server does — so a caller that does not know a
 * reachable graph API leaves the configured value (or its loopback default) in place rather
 * than inventing one.
 */
export interface UnionServerOptions extends ServerOptions {
  /** Base URL the graph tools call; absent leaves the graph MCP config's own resolution. */
  readonly kgBaseUrl?: string;
}

/**
 * Build the server both transports serve.
 *
 * Transport-agnostic, like `createWikiMcpServer`: the caller decides how the bytes arrive,
 * and this function decides only WHICH tools exist.
 *
 * @param options - Root, version, dimensions port, and the graph tools' base URL.
 * @returns A server carrying the wiki tools, the graph tools, and nothing connected yet.
 */
export function createUnionMcpServer(options: UnionServerOptions): McpServer {
  const server = createWikiMcpServer(options);
  // The graph registration is LAST and additive: it cannot remove, rename or shadow a wiki
  // tool, and the one name both dimensions declare is excluded at the source.
  registerKgToolsOn(server, options.kgBaseUrl === undefined ? {} : { baseUrl: options.kgBaseUrl });
  return server;
}

/**
 * Start the union over stdio, for the container's default mode.
 *
 * The dimensions port is REQUIRED here for the same reason `startMCPServer` requires it:
 * `serve` is an entry point a deployment starts, and a wiring mistake that handed the ingest
 * tool no port must be refused at construction rather than discovered mid-ingest. The graph
 * tools need no such port — they reach a graph API over HTTP or fail their own call.
 *
 * @param options - Root, version, dimensions port, and the graph tools' base URL.
 * @throws {MissingDimensionsPortError} when the caller supplied no dimensions port.
 */
export async function startUnionMcpServer(options: UnionServerOptions): Promise<void> {
  const dimensionsPort = requireDimensionsPort(options.dimensionsPort, INGEST_DIMENSIONS);
  const server = createUnionMcpServer({ ...options, dimensionsPort });
  await server.connect(new StdioServerTransport());
}

/**
 * The base URL a graph tool should call when this process serves the graph itself.
 *
 * Two answers, and the first one is a refusal to answer: when `AKS_BASE_URL` is configured
 * the operator has already said where the graph API is, and the graph MCP config has already
 * read it, so this returns `undefined` and the configured value stands. Only when nothing is
 * configured does the listener this host bound become the answer — the graph sub-app is
 * mounted on it, so a tool call is answered by the process that accepted it.
 *
 * @param bound - The address the listener actually bound, never the requested one: `--port 0`
 *   only becomes a number after `listen`, and a tool call dialing `0` would be dead on arrival.
 * @returns The loopback-reachable base URL, or `undefined` when a configured one applies.
 */
export function selfServedKgBaseUrl(bound: McpBoundAddress): string | undefined {
  const configured = (process.env[KG_BASE_URL_ENV_VAR] ?? "").trim();
  if (configured !== "") return undefined;
  return `http://${bound.host}:${bound.port}`;
}
