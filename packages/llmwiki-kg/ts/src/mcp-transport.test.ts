/**
 * @file packages/llmwiki-kg/ts/src/mcp-transport.test.ts
 * @description The MCP handshake over the in-memory transport.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "./mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BASE_URL, EXPECTED_STACKS, ORACLE_STACKS_BODY, PYTHON_TOOLS, recordingFetch } from "./mcp-harness.js";
import type { RecordedRequest, StubResponse } from "./mcp-harness.js";

describe("MCP handshake over the in-memory transport", () => {
  /** Connect a real SDK client to the server under test. */
  async function connect(screen: StubResponse): Promise<{
    client: Client;
    requests: RecordedRequest[];
    close: () => Promise<void>;
  }> {
    const { fetchImpl, requests } = recordingFetch(screen);
    const server = createMcpServer({ fetchImpl, baseUrl: BASE_URL, apiKey: "" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return {
      client,
      requests,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it("answers tools/list with the four tools", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      const response = await harness.client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual([
        "query_stack",
        "traverse_stack",
        "get_entities",
        "list_stacks",
      ]);
      // The protocol layer serializes inputSchema; it must survive unchanged.
      expect(JSON.parse(JSON.stringify(response.tools))).toEqual(PYTHON_TOOLS);
    } finally {
      await harness.close();
    }
  });

  it("routes tools/call through to HTTP and returns the formatted text", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      const result = await harness.client.callTool({ name: "list_stacks", arguments: {} });
      const content = result.content;
      expect(Array.isArray(content)).toBe(true);
      const [first] = content as ReadonlyArray<{ type: string; text?: string }>;
      expect(first?.type).toBe("text");
      expect(first?.text).toBe(EXPECTED_STACKS);
      expect(harness.requests[0]?.url).toBe("http://localhost:8000/stacks");
    } finally {
      await harness.close();
    }
  });

  it("surfaces unknown-tool text over the protocol, not a protocol error", async () => {
    const harness = await connect({ status: 200, body: "{}" });
    try {
      const result = await harness.client.callTool({ name: "bogus", arguments: {} });
      const [first] = result.content as ReadonlyArray<{ type: string; text?: string }>;
      expect(first?.text).toBe("Unknown tool: bogus");
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
