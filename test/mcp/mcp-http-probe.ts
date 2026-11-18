/**
 * @file test/mcp/mcp-http-probe.ts
 * @description The one streamable-HTTP `/mcp` probe the launcher suites share.
 *
 * ## Why this is a module and not a helper in each suite
 *
 * Several suites spawn `host` and post JSON-RPC to `<base>/mcp` for different reasons: one asserts
 * the union's CONTENT, another what the inventory becomes when the graph surface is switched off.
 * The framing is identical — a `POST` with both accepted media types, an SSE-framed reply decoded
 * out of its `data:` line, a 200 asserted before the body is parsed — and written twice it drifts
 * on the headers or the framing without either copy being wrong on its own.
 *
 * This module intentionally contains no `describe`/`it`: importing it from a suite must not
 * register a second copy of that suite's cases.
 */
import { expect } from "vitest";

/** The published MCP path (`MCP_HTTP_PATH`), spelled here so a source edit cannot hide a drift. */
const MCP_HTTP_PATH = "/mcp";

/** The headers a streamable-HTTP MCP client must send. */
const MCP_HTTP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

/** One JSON-RPC reply over HTTP, as far as the launcher suites read it. */
export interface McpHttpReply {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly error?: { readonly code: number; readonly message: string };
  readonly result?: {
    readonly serverInfo?: { readonly name?: string; readonly version?: string };
    readonly tools?: readonly { readonly name: string }[];
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
  };
}

/** Pull the JSON-RPC payload out of an SSE-framed or plain JSON response body. */
function rpcPayload(raw: string): McpHttpReply {
  const framed = raw.match(/^data: (.+)$/m);
  return JSON.parse(framed?.[1] ?? raw) as McpHttpReply;
}

/**
 * Post one JSON-RPC message to `/mcp` and decode its reply.
 *
 * @param base - The base URL the child announced.
 * @param body - The JSON-RPC message to post.
 * @returns The decoded reply, after asserting the transport answered 200.
 */
export async function postMcpRpc(base: string, body: unknown): Promise<McpHttpReply> {
  const response = await fetch(`${base}${MCP_HTTP_PATH}`, {
    method: "POST",
    headers: MCP_HTTP_HEADERS,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return rpcPayload(await response.text());
}
