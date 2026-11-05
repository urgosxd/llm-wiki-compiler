/**
 * @file packages/llmwiki-kg/ts/src/mcp-transport.test.ts
 * @description The MCP handshake over the in-memory transport.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "./mcp.js";
import { stackIdProblem } from "./stack-id.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BASE_URL,
  CONTRACT_STACK_KEYS,
  EXPECTED_CTX,
  EXPECTED_ENTS,
  EXPECTED_TRAV,
  ORACLE_STACKS_BODY,
  SYNTHETIC_CONTEXT_RESPONSE,
  SYNTHETIC_ENTITIES_RESPONSE,
  SYNTHETIC_TRAVERSE_RESPONSE,
  payloadOf,
  recordingFetch,
  textOf,
} from "./mcp-harness.js";
import type { RecordedRequest, StubResponse } from "./mcp-harness.js";

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

/* A Stack id with the canonical lowercase-UUID shape the API accepts. */
const VALID_STACK = "20efd96a-f6e1-4994-8812-65113f8db4db";

/** The three graph tools, each with every argument it needs except the Stack. */
const GRAPH_TOOLS = [
  { name: "query_stack", args: { query: "how are refunds handled?" } },
  { name: "traverse_stack", args: { start: "Payment Service" } },
  { name: "get_entities", args: {} },
] as const;

const MISSING_STACK_TEXT = "Error: 'stackId' must be provided.";

describe("MCP handshake over the in-memory transport", () => {
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
    } finally {
      await harness.close();
    }
  });

  it("routes tools/call through to HTTP and answers the JSON contract", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      const result = await harness.client.callTool({ name: "list_stacks", arguments: {} });
      const payload = payloadOf(result) as {
        stacks: ReadonlyArray<Record<string, unknown>>;
        count: number;
      };
      // Prose is gone: a data-listing tool answers machine-readable data.
      expect(Object.keys(payload)).toEqual(["stacks", "count"]);
      expect(payload.count).toBe(payload.stacks.length);
      expect(Object.keys(payload.stacks[0] ?? {})).toEqual([...CONTRACT_STACK_KEYS]);
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

describe("stackId is a required tool argument", () => {
  it("advertises stackId in `required` on all three graph tools", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      const { tools } = await harness.client.listTools();
      const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
      for (const { name } of GRAPH_TOOLS) {
        const required = schemas.get(name)?.["required"] as readonly string[] | undefined;
        expect(required, name).toContain("stackId");
      }
    } finally {
      await harness.close();
    }
  });

  it("declares list_stacks exempt from the required stackId", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      const { tools } = await harness.client.listTools();
      const list = tools.find((tool) => tool.name === "list_stacks");
      // A discovery tool cannot require the identifier of the thing it
      // discovers, so the exemption is decided rather than overlooked. The two
      // arguments it DOES declare only bound the listing and mark one entry.
      expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual(["limit", "stackId"]);
      expect(list?.inputSchema["required"]).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("refuses a call with no stackId and issues no graph request", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      for (const { name, args } of GRAPH_TOOLS) {
        const result = await harness.client.callTool({ name, arguments: { ...args } });
        expect(textOf(result), name).toBe(MISSING_STACK_TEXT);
        // A refusal, not an answer: `isError` is what lets a client branch on it.
        expect(result.isError, name).toBe(true);
      }
      // Nothing reached the backend, so nothing could have been written.
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("refuses a call that passes only domain", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      for (const { name, args } of GRAPH_TOOLS) {
        const result = await harness.client.callTool({
          name,
          arguments: { ...args, domain: "w1doc-probe-main" },
        });
        // `domain` no longer substitutes for the Stack (S7).
        expect(textOf(result), name).toBe(MISSING_STACK_TEXT);
        expect(result.isError, name).toBe(true);
      }
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("forwards stackId plus domain when both are supplied", async () => {
    const harness = await connect({ status: 200, body: SYNTHETIC_CONTEXT_RESPONSE });
    try {
      const result = await harness.client.callTool({
        name: "query_stack",
        arguments: {
          query: "how are refunds handled?",
          stackId: VALID_STACK,
          domain: "w1doc-probe-main",
        },
      });
      expect(harness.requests[0]?.body).toBe(
        `{"query":"how are refunds handled?","max_entities":8,"stackId":"${VALID_STACK}","domain":"w1doc-probe-main"}`,
      );
      expect(textOf(result)).toBe(EXPECTED_CTX);
    } finally {
      await harness.close();
    }
  });

  it("query_stack still reaches HTTP under the stackId key", async () => {
    const harness = await connect({ status: 200, body: SYNTHETIC_CONTEXT_RESPONSE });
    try {
      const result = await harness.client.callTool({
        name: "query_stack",
        arguments: { query: "how are refunds handled?", stackId: VALID_STACK },
      });
      expect(harness.requests[0]?.body).toBe(
        `{"query":"how are refunds handled?","max_entities":8,"stackId":"${VALID_STACK}"}`,
      );
      expect(textOf(result)).toBe(EXPECTED_CTX);
    } finally {
      await harness.close();
    }
  });

  it("traverse_stack still reaches HTTP under the stackId key", async () => {
    const harness = await connect({ status: 200, body: SYNTHETIC_TRAVERSE_RESPONSE });
    try {
      const result = await harness.client.callTool({
        name: "traverse_stack",
        arguments: { start: "Payment Service", stackId: VALID_STACK },
      });
      expect(harness.requests[0]?.url).toBe(
        `http://localhost:8000/aks/v1/traverse?start=Payment+Service&max_depth=2&stackId=${VALID_STACK}`,
      );
      expect(textOf(result)).toBe(EXPECTED_TRAV);
    } finally {
      await harness.close();
    }
  });

  it("get_entities still reaches HTTP under the stackId key", async () => {
    const harness = await connect({ status: 200, body: SYNTHETIC_ENTITIES_RESPONSE });
    try {
      const result = await harness.client.callTool({
        name: "get_entities",
        arguments: { stackId: VALID_STACK, type: "System" },
      });
      expect(harness.requests[0]?.url).toBe(
        `http://localhost:8000/aks/v1/entities?min_confidence=0.0&limit=100&stackId=${VALID_STACK}&type=System`,
      );
      expect(textOf(result)).toBe(EXPECTED_ENTS);
    } finally {
      await harness.close();
    }
  });
});

describe("stackId is the one caller-facing Stack argument (S1)", () => {
  /** A caller-supplied id that is not the canonical UUID form. */
  const MALFORMED_STACK = "not-a-uuid";

  it("declares stackId, and no stack_id, on all three graph tools", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      const { tools } = await harness.client.listTools();
      const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
      for (const { name } of GRAPH_TOOLS) {
        const schema = schemas.get(name);
        const properties = (schema?.["properties"] ?? {}) as Record<string, unknown>;
        expect(Object.hasOwn(properties, "stackId"), name).toBe(true);
        // The old spelling must be gone from the caller-facing surface, not
        // merely deprecated: two names for one concept is the defect (S1).
        expect(Object.hasOwn(properties, "stack_id"), name).toBe(false);
        expect(schema?.["required"], name).toContain("stackId");
      }
    } finally {
      await harness.close();
    }
  });

  it("refuses a malformed stackId before any HTTP request", async () => {
    const harness = await connect({ status: 200, body: ORACLE_STACKS_BODY });
    try {
      for (const { name, args } of GRAPH_TOOLS) {
        const result = await harness.client.callTool({
          name,
          arguments: { ...args, stackId: MALFORMED_STACK },
        });
        expect(result.isError, name).toBe(true);
        // The shared rule is the ONLY source of the wording: the earlier composed
        // prefix stated the UUID rule twice from two sources (T2 follow-up).
        expect(textOf(result), name).toBe(`Error: ${stackIdProblem(MALFORMED_STACK)}`);
      }
      // The rule is a refusal BEFORE the hop: a request issued here would let
      // an unusable id reach the backend, which is the defect (S1).
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("still sends a well-formed stackId under the HTTP stackId key", async () => {
    // The rename is caller-facing only. The published HTTP body keeps its
    // snake_case key until the DTO and the routes rename together.
    const harness = await connect({ status: 200, body: SYNTHETIC_CONTEXT_RESPONSE });
    try {
      await harness.client.callTool({
        name: "query_stack",
        arguments: { query: "q", stackId: VALID_STACK },
      });
      expect(harness.requests[0]?.body).toBe(
        `{"query":"q","max_entities":8,"stackId":"${VALID_STACK}"}`,
      );
    } finally {
      await harness.close();
    }
  });
});
