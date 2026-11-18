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
 * This module deliberately has NO import of `../mcp/**`, and that holds whatever
 * the MCP modules themselves import: the host builds the server and hands the
 * factory in, so this module only ever speaks HTTP to it.
 *
 * The rule comes from a cycle that was REAL, and it is still why the factory is
 * injected. A static edge closed one: `host/server.ts -> mcp-http.ts ->
 * mcp/server.ts -> mcp/tools.ts -> compiler-cli.ts -> commands/host.ts ->
 * host/server.ts`. The chain ran through `compiler-cli.ts`, a public barrel that
 * re-exported `hostCommand` (since deleted, together with the `host` command the
 * launcher replaced), so any import path from the host into the MCP tools
 * re-entered the host module. `fallow` reported exactly those three cycles (one
 * per tools barrel: tools, okf-tools, resources) the moment the static import
 * existed, and a dynamic `import()` did not help because the cycle is still visible
 * to static analysis.
 *
 * That edge has since been removed: the MCP modules now import their symbols from
 * the DEFINING modules instead of through the barrel, so `mcp/tools.ts` no longer
 * reaches `compiler-cli.ts` and the chain above is broken at its barrel link. The
 * injected factory stays all the same — it is the reason this module can never gain
 * the edge back, it costs one parameter, and `test/artifact/mcp-import-surface.test.ts`
 * now pins the barrel's absence from `src/mcp/**`, so a reintroduction fails a test
 * instead of waiting for `fallow` to notice a cycle. Belt as well as braces.
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
 *
 * ## Why this endpoint carries the GRAPH's policy and not a new one
 *
 * Two MCP surfaces were merged into one path, so the path can carry exactly one policy: the
 * graph's, `X-API-Key`. It is the graph package's own middleware — {@link apiKeyPolicy}, built
 * from `createRequireApiKey` and the process config — and not a second copy of the rule, so its
 * two existing semantics come along unchanged:
 *
 *   - a configured key (`AKS_API_KEY` non-blank) requires the header, and a missing or wrong one
 *     is refused with the graph's 401 and its exact `detail` body;
 *   - NO configured key is FAIL-OPEN, the same pass-through the graph image has today. This is
 *     what keeps every deployment that runs without a key — including the published image's
 *     default — reaching the wiki tools exactly as before.
 *
 * The consequence is a documented operator decision, not an accident: an operator who SETS a key
 * now needs the header for the wiki tools too, because one endpoint cannot hold two policies.
 * Nothing else changes: the viewer, `/api/**` and the graph's own routes keep their own policies,
 * and this module claims no path but `/mcp`.
 *
 * ## Why the policy sees a FACADE response rather than an Express one
 *
 * The middleware is an Express handler, and this module deliberately owns no Express app (see
 * the injected factory above): `packages/api` declares no `express` dependency. The middleware
 * touches exactly three members — `req.headers`, `res.status(code)` and `res.json(body)` — so
 * {@link policyResponse} implements those two response methods over the real `ServerResponse`
 * and nothing else. No decision lives in the facade: the status and the body both come from
 * `auth.ts`, and `json` writes the bytes that constant produces, which is what makes the refusal
 * byte-for-byte the graph's.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRequireApiKey, kgConfig } from "@repo/kg";

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
 * The graph's API-key middleware, type-narrowed to the three members it actually uses.
 *
 * The parameters stay `unknown`-shaped because the middleware declares EXPRESS request and
 * response objects and this module has none: the cast is the whole adaptation, and it is safe
 * for exactly the reason {@link policyResponse} exists — `auth.ts` reads `req.headers` and calls
 * `res.status`/`res.json`, and nothing else. Narrowing here rather than at each call site keeps
 * one place answerable for that claim.
 */
type ApiKeyPolicy = (req: unknown, res: unknown, next: () => void) => void;

/** The policy, bound to the process config: `authEnabled` decides, per request. */
const apiKeyPolicy = createRequireApiKey(kgConfig) as unknown as ApiKeyPolicy;

/** The two response methods {@link apiKeyPolicy} calls. */
interface PolicyResponse {
  /** Record the status the policy refused with. */
  status(code: number): PolicyResponse;
  /** Write the body the policy refused with, exactly as it serializes. */
  json(body: unknown): void;
}

/**
 * The Express-response surface the policy needs, over the real `ServerResponse`.
 *
 * No decision is made here: the status and the body arrive from `auth.ts`, and this only writes
 * them. The body is `JSON.stringify`'d, which is what Express's `json` does, so the refusal keeps
 * the graph's byte-exact shape (`{"detail":"…"}`) and every client that already parses a graph
 * 401 keeps working.
 *
 * @param res - The response the request was handed with.
 * @returns The facade to hand the policy.
 */
function policyResponse(res: ServerResponse): PolicyResponse {
  const facade: PolicyResponse = {
    status(code: number): PolicyResponse {
      res.statusCode = code;
      return facade;
    },
    json(body: unknown): void {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    },
  };
  return facade;
}

/**
 * Run the graph's policy for this request, answering a refusal itself.
 *
 * @param req - Incoming request, judged on its `X-API-Key` header alone.
 * @param res - Response to write a refusal to.
 * @returns True when the request was admitted; false when a refusal was already written.
 */
function admitApiKey(req: IncomingMessage, res: ServerResponse): boolean {
  let admitted = false;
  apiKeyPolicy(req, policyResponse(res), () => {
    admitted = true;
  });
  return admitted;
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
  // BEFORE any method handling: the endpoint is one surface with one policy, so a refused
  // caller learns nothing about it — not even which methods it accepts.
  if (!admitApiKey(req, res)) return;

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
