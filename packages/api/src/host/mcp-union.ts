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
 *
 * `serve` (stdio) binds no listener, so the same module that decides WHICH ADDRESS the tools
 * call also provides one there: {@link startGraphListener}, a loopback ephemeral listener
 * serving the graph sub-app inside the same process. Without it the container's DEFAULT mode
 * advertised three graph tools that answered `fetch failed`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requireDimensionsPort } from "@repo/foundation";
import { createApp } from "@repo/kg/server";
import { registerKgToolsOn } from "@repo/kg/mcp";
import { createWikiMcpServer, type ServerOptions } from "@repo/wiki/mcp";
import { INGEST_DIMENSIONS } from "@repo/wiki/ingest-service";
import { listenOn } from "@repo/wiki/http-listen";
import { writeJsonError } from "@repo/wiki/viewer-respond";

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
 * What the stdio transport needs beyond a transport-agnostic server: something to close when the
 * session ends.
 */
export interface UnionStdioOptions extends UnionServerOptions {
  /**
   * Closed once the stdio session ends, BEFORE the server's own close runs.
   *
   * A listener this process bound exists to answer THIS session's graph tools and nothing else, so
   * it must not outlive it: an open server handle keeps the event loop alive, and `serve` is
   * documented to exit 0 when its client closes stdin.
   */
  readonly onSessionEnd?: () => Promise<void> | void;
}

/**
 * Start the union over stdio, for the container's default mode.
 *
 * The dimensions port is REQUIRED here for the same reason `startMCPServer` requires it:
 * `serve` is an entry point a deployment starts, and a wiring mistake that handed the ingest
 * tool no port must be refused at construction rather than discovered mid-ingest. The graph
 * tools need no such port — they reach a graph API over HTTP or fail their own call.
 *
 * @param options - Root, version, dimensions port, the graph tools' base URL, and the session's
 *   own close hook.
 * @throws {MissingDimensionsPortError} when the caller supplied no dimensions port.
 */
export async function startUnionMcpServer(options: UnionStdioOptions): Promise<void> {
  const dimensionsPort = requireDimensionsPort(options.dimensionsPort, INGEST_DIMENSIONS);
  const server = createUnionMcpServer({ ...options, dimensionsPort });
  const transport = new StdioServerTransport();
  const onSessionEnd = options.onSessionEnd;
  if (onSessionEnd !== undefined) {
    // `end`, NOT `transport.onclose`: the SDK's stdio transport notifies `onclose` from its own
    // `close()`, and it listens for `data` and `error` only — an ended stdin never reaches it.
    // Today `serve` exits because an ended stdin leaves the process with no handles, so a listener
    // bound for this session would keep it alive forever without this line.
    process.stdin.once("end", () => {
      void onSessionEnd();
    });
  }
  await server.connect(transport);
}

/**
 * The graph API an operator named, or `undefined` when nothing is configured.
 *
 * ONE reader for "is an external graph API configured", because two callers need it for opposite
 * reasons and a second copy of the trim-and-compare would let them disagree: {@link selfServedKgBaseUrl}
 * refuses to answer when it is set, and a caller that has to decide whether to
 * bind a listener at all asks this BEFORE it has an address to offer.
 *
 * @param env - The environment to read; the process's own by default.
 * @returns The configured value, trimmed, or `undefined` when it is absent or blank.
 */
export function configuredKgBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = (env[KG_BASE_URL_ENV_VAR] ?? "").trim();
  return configured === "" ? undefined : configured;
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
 * @param env - The environment to read; the process's own by default.
 * @returns The loopback-reachable base URL, or `undefined` when a configured one applies.
 */
export function selfServedKgBaseUrl(
  bound: McpBoundAddress,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configuredKgBaseUrl(env) !== undefined) return undefined;
  return `http://${bound.host}:${bound.port}`;
}

/** The graph prefix the union's graph tools call — and the only prefix a self-served listener serves. */
const KG_TOOL_PATH_PREFIX = "/aks/v1";

/**
 * Does one URL belong to the prefix the union's graph tools call?
 *
 * @param url - The request URL, query string included.
 * @returns Whether the graph tool surface owns it.
 */
function isKgToolPath(url: string | undefined): boolean {
  const pathname = (url ?? "/").split("?")[0] ?? "/";
  return pathname === KG_TOOL_PATH_PREFIX || pathname.startsWith(`${KG_TOOL_PATH_PREFIX}/`);
}

/** A graph-only listener this process bound: the address it ACTUALLY got, and its close path. */
export interface GraphListenerHandle extends McpBoundAddress {
  /** Stop accepting, drop every open connection, and resolve once the listener is closed. */
  close(): Promise<void>;
}

/**
 * Bind the graph sub-app alone, on loopback, on an OS-assigned port.
 *
 * This is the smallest listener that can answer a graph tool in `serve` mode, and deliberately
 * NOT `startHost` with the viewer switched off: no snapshot, no mutation mount, no job registry,
 * no `/mcp`, no reaper. `createApp()` builds without binding and connects to nothing, so a boot
 * that calls this still opens no database connection.
 *
 * Two properties are structural rather than configured:
 *
 *  - the bind address is loopback and is NOT a parameter, so no caller can widen it; and
 *  - only {@link KG_TOOL_PATH_PREFIX} is dispatched, so the graph app's WRITE routes
 *    (`/documents`, `/ingest`, `/synthesize`, `POST /stacks`) are not published on a port
 *    `serve` opened on its own initiative. The union's graph tools call nothing else.
 *
 * @returns The bound address and a close path.
 */
export async function startGraphListener(): Promise<GraphListenerHandle> {
  const graph = createApp();
  const server = http.createServer((req, res) => {
    if (!isKgToolPath(req.url)) {
      writeJsonError(res, 404, "not_found", `this listener serves only ${KG_TOOL_PATH_PREFIX}`);
      return;
    }
    graph(req, res);
  });
  await listenOn(server, 0, LOOPBACK_HOST);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("graph listener bound but address is null");
  let closing: Promise<void> | undefined;
  return {
    host: LOOPBACK_HOST,
    port: address.port,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        // A tool call's keep-alive socket would otherwise hold the process open past the session
        // that needed it, and `serve` exits 0 when its client closes stdin.
        server.closeAllConnections();
      })),
  };
}

/** The only address a self-served graph listener may bind: loopback, never `0.0.0.0`. */
const LOOPBACK_HOST = "127.0.0.1";
