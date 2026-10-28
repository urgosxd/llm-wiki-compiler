/**
 * @file test/host/mcp-http.test.ts
 * @description The MCP tools must be reachable over HTTP, not only over stdio.
 *
 * ## Why this file exists
 *
 * stdio is the default surface and it is invisible to a remote consumer: reaching it
 * means spawning this binary, which a consumer that has decided not to embed this
 * service cannot do. The host therefore serves the same 14 tools at `/mcp`. Nothing
 * pinned that, and the failure mode is silent — the tools exist, the listener is up,
 * and the endpoint answers 404 from the viewer because the path was never claimed.
 *
 * ## Why the assertions talk to a real listener
 *
 * `createDispatcher` decides ownership, and the whole class of bug this guards
 * against lives in that decision rather than in the handler. A test that called
 * `handleMcpHttp` directly would pass while production 404s — the same gap that made
 * `/domain` unreachable once.
 */

import { describe, expect, it } from "vitest";
import { runningHost } from "../fixtures/running-host.js";
import { MCP_HTTP_PATH } from "../../src/host/mcp-http.js";
import { createWikiMcpServer } from "../../src/mcp/server.js";

/** The factory the CLI injects; tests must supply it for the same reason. */
function mcpFactory(root: string): () => ReturnType<typeof createWikiMcpServer> {
  return () => createWikiMcpServer({ root, version: "test" });
}

/** Headers a streamable-HTTP MCP client must send. */
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

/** Pull the JSON-RPC payload out of an SSE-framed or plain JSON response. */
function rpcPayload(raw: string): Record<string, unknown> {
  const framed = raw.match(/^data: (.+)$/m);
  return JSON.parse(framed?.[1] ?? raw) as Record<string, unknown>;
}

/** Call the endpoint with one JSON-RPC message and return its payload. */
async function rpc(base: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${MCP_HTTP_PATH}`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
  return rpcPayload(await response.text());
}

describe("the host serves MCP over streamable HTTP", () => {
  it("is reachable at /mcp rather than falling through to the viewer", async () => {
    // MCP is mounted alongside the mutation endpoints, so the host needs a project
    // root; without one there is nothing for a mutating tool to operate on.
    const { handle, base } = await runningHost("mcp-http-", { projectRoot: process.cwd(), mcpServerFactory: mcpFactory(process.cwd()) });
    try {
      const response = await fetch(`${base}${MCP_HTTP_PATH}`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "probe", version: "1" },
          },
        }),
      });
      // The viewer registers no `/mcp`, so a 404 here means the path was never
      // claimed and a remote consumer has no route to any tool.
      expect(response.status).toBe(200);
      const payload = rpcPayload(await response.text());
      expect(JSON.stringify(payload)).toContain("llmwiki");
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("lists every tool the stdio server registers, including the job reads", async () => {
    const { handle, base } = await runningHost("mcp-tools-", { projectRoot: process.cwd(), mcpServerFactory: mcpFactory(process.cwd()) });
    try {
      const payload = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const result = payload.result as { tools: { name: string }[] };
      const names = result.tools.map((tool) => tool.name);
      expect(names).toContain("ingest_job_status");
      expect(names).toContain("ingest_jobs_list");
      // 14 is the stdio count; a lower number here means the HTTP mount registered
      // a different (or partial) tool set, which is the drift this test exists for.
      expect(names.length).toBe(14);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("answers a malformed body with a JSON-RPC parse error, not a crash", async () => {
    const { handle, base } = await runningHost("mcp-bad-", { projectRoot: process.cwd(), mcpServerFactory: mcpFactory(process.cwd()) });
    try {
      const response = await fetch(`${base}${MCP_HTTP_PATH}`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: "not-json",
      });
      expect(response.status).toBe(400);
      const payload = rpcPayload(await response.text());
      expect((payload.error as { code?: number }).code).toBe(-32700);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
