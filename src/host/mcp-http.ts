/**
 * @file src/host/mcp-http.ts
 * @description Serve the same MCP tools over streamable HTTP, at `/mcp`.
 *
 * ## Why this exists
 *
 * stdio is the right default: a local client spawns the binary and talks pipes, and
 * nothing is exposed on a socket. But a REMOTE consumer cannot use it. A consumer
 * that reaches this product over the network would have to ship this binary inside
 * its own image just to spawn it — and a consumer that has explicitly decided not to
 * embed this service (AgentDocumentor, whose T13 records exactly that constraint)
 * then has no route to these tools at all, not even the durable job reads built for
 * it.
 *
 * So the host also speaks streamable HTTP on the listener it already owns. One
 * container, one port, MCP and the API side by side, and nothing of this product
 * enters the consumer's image.
 *
 * ## Why the server factory is INJECTED
 *
 * This module deliberately has NO import of `../mcp/**`. A static edge closes a
 * cycle: `host/server.ts -> mcp-http.ts -> mcp/server.ts -> mcp/tools.ts ->
 * compiler-cli.ts -> commands/host.ts -> host/server.ts`. The chain runs through
 * `compiler-cli.ts`, a public barrel that re-exports `hostCommand`, so any import
 * path from the host into the MCP tools re-enters the host module. `fallow` reported
 * exactly those three cycles (one per tools barrel: tools, okf-tools, resources) the
 * moment the static import existed, and a dynamic `import()` did not help because the
 * cycle is still visible to static analysis.
 *
 * Injecting the factory removes the edge entirely: the host builds the server, this
 * module only speaks HTTP to it.
 *
 * ## Why stateless
 *
 * Session state would have to live somewhere: in one process's memory, which breaks
 * the moment two replicas sit behind a load balancer, or in a store, which is a whole
 * subsystem for read-mostly tools. Stateless costs re-initialization per request —
 * a few hundred bytes — and buys a listener any number of concurrent callers can hit
 * without coordination.
 *
 * ## Why the body is parsed here
 *
 * The SDK's Node transport takes an optional pre-parsed body. The host's dispatcher is
 * a bare `(req, res)` pair with no body middleware, so this module reads the JSON
 * itself, with a bound, and hands the result over.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Path this module claims. One constant so the mount and the check cannot drift. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * Largest request body accepted, in bytes.
 *
 * MCP requests carry tool arguments, not documents: the largest realistic payload is
 * an inline prompt. 1 MiB is far above that and far below anything that would let one
 * caller hold the listener's memory.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** JSON-RPC error for a body that could not be read, in the MCP envelope shape. */
const PARSE_ERROR_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32700, message: "Parse error: body must be a JSON object" },
  id: null,
});

/** The minimal shape this module needs from an `McpServer`. */
export interface McpHttpServer {
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Builds a fresh server per request.
 *
 * A factory rather than an instance because `connect` binds one transport for the
 * server's lifetime: sharing one server across concurrent requests would serialize
 * them, and stateless mode exists to avoid exactly that.
 */
export type McpHttpServerFactory = () => McpHttpServer;

/** True when `url` addresses the MCP endpoint, query string ignored. */
export function isMcpHttpPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  const pathname = url.split("?")[0] ?? "/";
  return pathname === MCP_HTTP_PATH;
}

/**
 * Read the whole body, refusing anything oversized.
 *
 * @param req - Incoming request.
 * @returns The parsed JSON value, or `undefined` when it is absent or unparseable.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Answer with the JSON-RPC parse error the transport would have produced. */
function writeParseError(res: ServerResponse): void {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(PARSE_ERROR_BODY);
}

/**
 * Handle one MCP-over-HTTP request.
 *
 * @param req - Incoming request.
 * @param res - Response to write.
 * @param createServer - Builds the server for this request.
 */
export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  createServer: McpHttpServerFactory,
): Promise<void> {
  // DELETE ends a session this module does not keep, so there is nothing to do.
  // Answering 405 rather than 200 keeps a client from believing it cleaned up.
  if (req.method === "DELETE") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end();
    return;
  }

  const body = req.method === "POST" ? await readJsonBody(req) : undefined;
  if (req.method === "POST" && body === undefined) {
    writeParseError(res);
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    // Closing after the response keeps a per-request server from leaking its
    // transport listeners; `handleRequest` has already written the reply by here.
    await server.close().catch(() => undefined);
  }
}
