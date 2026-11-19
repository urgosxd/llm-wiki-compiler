/**
 * @file packages/llmwiki-kg/ts/src/mcp-accepted-only.test.ts
 * @description `accepted_only` as the MCP client sees it: schema, description, wire.
 *
 * Two things are the contract here. The ADVERTISED description has to carry both
 * halves — that rejected items are present by default and that `accepted_only`
 * removes them — because a wide default nobody announced is a trap. And the
 * argument has to reach the HTTP request unchanged, with a non-boolean refused
 * before any request is issued: the MCP argument channel has no schema
 * enforcement, so `"false"` would otherwise travel as text.
 */

import { describe, expect, it } from "vitest";

import { callTool, listTools } from "./mcp.js";
import { BASE_URL, SYNTHETIC_CONTEXT_RESPONSE, SYNTHETIC_ENTITIES_RESPONSE, SYNTHETIC_TRAVERSE_RESPONSE, recordingFetch, textOf } from "./mcp-harness.js";

/** A Stack id with the canonical lowercase-UUID shape the API accepts. */
const STACK = "20efd96a-f6e1-4994-8812-65113f8db4db";

/** The refusal a non-boolean `accepted_only` is answered with, before any request. */
const NON_BOOLEAN_REFUSAL = "Error: 'accepted_only' must be a boolean.";

/** The three tools that return graph content. */
const GRAPH_TOOLS = ["query_stack", "traverse_stack", "get_entities"] as const;

/** One tool's advertised description and property schema. */
function advertised(name: string): {
  description: string;
  property: { type?: string; default?: unknown; description?: string };
} {
  const tool = listTools().find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  const properties = (tool?.inputSchema.properties ?? {}) as Record<string, never>;
  return {
    description: tool?.description ?? "",
    property: properties["accepted_only"] ?? {},
  };
}

describe("accepted_only in the advertised MCP contract", () => {
  it("declares one boolean named accepted_only, defaulting to false, on every graph tool", () => {
    for (const name of GRAPH_TOOLS) {
      const { property } = advertised(name);
      // The SAME name, type and default on all three: a flag spelled differently
      // per tool is not one flag.
      expect(property.type, name).toBe("boolean");
      expect(property.default, name).toBe(false);
      expect(property.description, name).toContain("present by default");
    }
  });

  it("states in every tool description that rejected items are present by default AND how to remove them", () => {
    for (const name of GRAPH_TOOLS) {
      const { description } = advertised(name);
      expect(description, name).toContain("Ontology-rejected items are present by default.");
      expect(description, name).toContain("accepted_only: true");
    }
  });
});

describe("accepted_only on the wire", () => {
  it("forwards it into the context body only when the client sets it", async () => {
    const omitted = recordingFetch({ status: 200, body: SYNTHETIC_CONTEXT_RESPONSE });
    await callTool("query_stack", { query: "q", stackId: STACK }, {
      fetchImpl: omitted.fetchImpl,
      baseUrl: BASE_URL,
    });
    expect(omitted.requests[0]?.body).toBe(
      `{"query":"q","max_entities":8,"stackId":"${STACK}"}`,
    );

    const set = recordingFetch({ status: 200, body: SYNTHETIC_CONTEXT_RESPONSE });
    await callTool("query_stack", { query: "q", stackId: STACK, accepted_only: true }, {
      fetchImpl: set.fetchImpl,
      baseUrl: BASE_URL,
    });
    expect(set.requests[0]?.body).toBe(
      `{"query":"q","max_entities":8,"stackId":"${STACK}","accepted_only":true}`,
    );
  });

  it("forwards it as a query parameter to traverse and to entities", async () => {
    const traverse = recordingFetch({ status: 200, body: SYNTHETIC_TRAVERSE_RESPONSE });
    await callTool("traverse_stack", { start: "Gateway", stackId: STACK, accepted_only: true }, {
      fetchImpl: traverse.fetchImpl,
      baseUrl: BASE_URL,
    });
    expect(traverse.requests[0]?.url).toContain("accepted_only=true");

    const entities = recordingFetch({ status: 200, body: SYNTHETIC_ENTITIES_RESPONSE });
    await callTool("get_entities", { stackId: STACK, accepted_only: true }, {
      fetchImpl: entities.fetchImpl,
      baseUrl: BASE_URL,
    });
    expect(entities.requests[0]?.url).toContain("accepted_only=true");
  });
});

describe("accepted_only refusals", () => {
  it("refuses a non-boolean instead of sending it, and sends nothing", async () => {
    for (const name of GRAPH_TOOLS) {
      const { fetchImpl, requests } = recordingFetch({ status: 200, body: "{}" });
      const args =
        name === "query_stack"
          ? { query: "q", stackId: STACK, accepted_only: "false" }
          : name === "traverse_stack"
            ? { start: "Gateway", stackId: STACK, accepted_only: "false" }
            : { stackId: STACK, accepted_only: "false" };

      const result = await callTool(name, args, { fetchImpl, baseUrl: BASE_URL });

      // The string `"false"` is refused, never read as true and never forwarded.
      expect(textOf(result), name).toBe(NON_BOOLEAN_REFUSAL);
      expect((result as { isError?: boolean }).isError, name).toBe(true);
      expect(requests, name).toHaveLength(0);
    }
  });
});