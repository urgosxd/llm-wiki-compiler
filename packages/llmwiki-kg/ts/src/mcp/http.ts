/**
 * @file packages/llmwiki-kg/ts/src/mcp/http.ts
 * @description Serve the four KG MCP tools over streamable HTTP, at `/mcp`.
 *
 * ## Why an HTTP transport exists here at all
 *
 * `mcp/server.ts` could only bind stdio, and stdio is a channel, not an
 * endpoint: a remote consumer would have to run this image inside its own to
 * spawn the binary. Worse, all four tools are HTTP CLIENTS of this same KG API
 * (`handlers.ts` fetches `${baseUrl}/stacks`, `/aks/v1/context`,
 * `/aks/v1/traverse`, `/aks/v1/entities`, with `AKS_BASE_URL` defaulting to
 * `http://localhost:8000`). A stdio-only build is therefore enumerable and
 * DEAD unless something else is already listening on that port. Serving MCP on
 * the listener the process already binds makes `baseUrl` and the mount the same
 * address, so a tool call is answered by the process that accepted it.
 *
 * ## Why stateless, with no session map
 *
 * Session state would have to live in this process's memory, which breaks the
 * moment two replicas sit behind one load balancer: a client's second request
 * would land on a process that never saw its `initialize`. Stateless costs one
 * re-initialization per request — a few hundred bytes — and buys a listener any
 * number of callers can hit without coordination. That is why
 * `sessionIdGenerator` is `undefined` and why `server.close()` runs per request.
 *
 * ## Why the body is handed over already parsed
 *
 * The SDK transport accepts a pre-parsed body. The mount parses it with
 * `express.json({ strict: false })` before reaching this handler, and the mount
 * carries its own error middleware right after that parser ({@link mcpErrorHandler}),
 * because without one a malformed body leaves this chain as body-parser's
 * `next(err)` and lands on Express's default handler: an HTML page, status 400,
 * with a `SyntaxError` stack naming `node_modules` paths — disclosed on a public
 * endpoint, and not the envelope the rest of the KG API answers with. With the
 * error handler in place a parse failure becomes `400 {"detail":…}` and nothing
 * else about the request changes. Because `/mcp` requests never fall through to
 * the inner `createApp()` app, no request is parsed twice.

 * The shape mirrors `packages/api/src/host/mcp-http.ts` deliberately: one
 * stateless request handler, one fresh server, one transport.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { StreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import type { McpDependencies } from "./handlers.js";
import { createMcpServer } from "./server.js";

/** The path this module claims. One constant, so the mount and the client cannot drift. */
export const MCP_HTTP_PATH = "/mcp";

/** The `detail` a rejected `/mcp` body is answered with; fixed, never echoed input. */
const INVALID_BODY_DETAIL = "Invalid JSON body";

/** The `detail` of any other 4xx failure in this chain: safe, caller-relevant, generic. */
const BAD_REQUEST_DETAIL = "Bad Request";

/** The `detail` of a 5xx failure: opaque, so internals never leak. */
const SERVER_ERROR_DETAIL = "Internal Server Error";

/**
 * The SDK's documented stateless mode, spelled out.
 *
 * `sessionIdGenerator: undefined` is what the SDK's own usage example writes for
 * stateless operation, and omitting the field would be indistinguishable from
 * forgetting it. The type, though, declares the field as `() => string` while
 * this package compiles with `exactOptionalPropertyTypes`, so an explicit
 * `undefined` is refused by the compiler and accepted by the SDK. One assertion
 * here keeps the intent readable in code rather than hidden in silence.
 */
const STATELESS_OPTIONS = {
  sessionIdGenerator: undefined,
} as unknown as StreamableHTTPServerTransportOptions;

/**
 * Hands the transport to `server.connect` through the `Transport` interface.
 *
 * `Transport` declares `onclose?: () => void`, while
 * `StreamableHTTPServerTransport` exposes the same member through an accessor
 * typed `(() => void) | undefined`. Under `exactOptionalPropertyTypes` the two
 * are not assignable, even though the class declares `implements Transport` — a
 * mismatch in the SDK's own types, not in this code. The assertion is confined
 * to this one boundary, with the reason named, rather than relaxing the flag for
 * the package.
 *
 * @param transport - The streamable HTTP transport for this request.
 * @returns The same object, typed as the interface `connect` accepts.
 */
function asTransport(transport: StreamableHTTPServerTransport): Transport {
  return transport as unknown as Transport;
}

/**
 * Handles one MCP request: a fresh server, a fresh stateless transport, one reply.
 *
 * `req.body` is whatever `express.json` already produced, which the SDK
 * transport prefers over reading the stream again.
 *
 * @param req - The request the mount handed over, body already parsed.
 * @param res - The response to write.
 * @param dependencies - Where the tools send their HTTP calls, and with which key.
 */
async function answerMcpRequest(
  req: Request,
  res: Response,
  dependencies: McpDependencies,
): Promise<void> {
  const server = createMcpServer(dependencies);
  const transport = new StreamableHTTPServerTransport(STATELESS_OPTIONS);
  const body: unknown = req.body;

  try {
    await server.connect(asTransport(transport));
    await transport.handleRequest(req, res, body);
  } finally {
    // Closing after the reply keeps a per-request server from leaking its
    // transport listeners; `handleRequest` has already written the response.
    await server.close().catch(() => undefined);
  }
}

/**
 * Builds the Express handler mounted at {@link MCP_HTTP_PATH}.
 *
 * A rejected request is forwarded to Express's error handler rather than
 * answered here, so a failure keeps the same envelope every other KG route uses.
 *
 * @param dependencies - Tool HTTP dependencies; defaults come from the MCP config.
 * @returns The request handler for the `/mcp` mount.
 */
export function createMcpHttpHandler(
  dependencies: McpDependencies = {},
): RequestHandler {
  return function handleMcpHttp(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    void answerMcpRequest(req, res, dependencies).catch(next);
  };
}

/**
 * Whether a failure is body-parser's own "the body was not JSON" refusal.
 *
 * body-parser tags every error it creates with a `type`; only the parse failure
 * carries `entity.parse.failed`. Distinguishing it matters because that one is
 * guaranteed to have a safe, fixed meaning, while any other error may be an
 * unexpected internal one whose message must not reach a caller.
 *
 * @param err - Whatever Express handed the error middleware.
 * @returns True only for a body-parser parse failure.
 */
function isBodyParseFailure(err: unknown): boolean {
  return err instanceof Error && (err as { type?: unknown }).type === "entity.parse.failed";
}

/**
 * The HTTP status to answer a non-parse failure with.
 *
 * Client-shaped errors keep their own status (`413` for an oversized body, say),
 * anything missing or out of range collapses to `500` so a malformed failure
 * cannot invent a status.
 *
 * @param err - Whatever Express handed the error middleware.
 * @returns A status in `400..599`; `500` when the error names none.
 */
function failureStatus(err: unknown): number {
  const named = (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  return typeof named === "number" && named >= 400 && named <= 599 ? named : 500;
}

/**
 * Keeps every failure of the `/mcp` chain inside the KG's JSON error envelope.
 *
 * Mounted after the JSON parser, so a rejected body — and any later failure in
 * this chain — is answered here instead of by Express's default handler, which
 * would disclose a `SyntaxError` stack over `node_modules` paths. A parse
 * failure gets a fixed `400 {"detail":"Invalid JSON body"}`; anything else keeps
 * a 4xx/5xx status with a generic `detail`. No path, no stack, no HTML.
 *
 * @param err - The failure forwarded by an earlier layer of this chain.
 * @param _req - Unused; the envelope does not depend on the request.
 * @param res - The response to write.
 * @param next - Forwarded to when the response is already committed.
 */
export const mcpErrorHandler: ErrorRequestHandler = function handleMcpError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (isBodyParseFailure(err)) {
    res.status(400).json({ detail: INVALID_BODY_DETAIL });
    return;
  }

  const status = failureStatus(err);
  res.status(status).json({ detail: status >= 500 ? SERVER_ERROR_DETAIL : BAD_REQUEST_DETAIL });
};
