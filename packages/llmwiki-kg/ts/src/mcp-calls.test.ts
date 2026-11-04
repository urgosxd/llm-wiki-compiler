/**
 * @file packages/llmwiki-kg/ts/src/mcp-calls.test.ts
 * @description `callTool` routing against a stubbed fetch.
 */

import { describe, expect, it } from "vitest";
import { callTool } from "./mcp.js";
import { BASE_URL, EXPECTED_CTX, EXPECTED_ENTS, EXPECTED_STACKS, EXPECTED_TRAV, ORACLE_STACKS_BODY, ORACLE_TRAVERSE_404_BODY, SYNTHETIC_CONTEXT_RESPONSE, SYNTHETIC_ENTITIES_RESPONSE, SYNTHETIC_TRAVERSE_RESPONSE, recordingFetch, textOf } from "./mcp-harness.js";

/** A Stack id with the canonical lowercase-UUID shape the API accepts. */
const STACK = "20efd96a-f6e1-4994-8812-65113f8db4db";

/** The refusal every graph tool answers when the Stack argument is absent. */
const MISSING_STACK_TEXT = "Error: 'stack_id' must be provided.";

describe("callTool routing", () => {
  it("returns `Unknown tool: <name>` as text, exactly like Python", () => {
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: "{}" });
    return callTool("no_such_tool", {}, { fetchImpl, baseUrl: BASE_URL }).then((result) => {
      expect(textOf(result)).toBe("Unknown tool: no_such_tool");
      // No HTTP call is made for an unknown tool.
      expect(requests).toHaveLength(0);
    });
  });

  it("POSTs query_stack to /aks/v1/context with the Python's payload", async () => {
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_CONTEXT_RESPONSE,
    });
    const result = await callTool(
      "query_stack",
      { query: "how are refunds handled?", stack_id: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("http://localhost:8000/aks/v1/context");
    // `max_entities` defaults to 8; the Stack is forwarded as the argument gave it.
    expect(request?.body).toBe(`{"query":"how are refunds handled?","max_entities":8,"stack_id":"${STACK}"}`);
    expect(textOf(result)).toBe(EXPECTED_CTX);
  });

  it("forwards stack_id and passes domain only as an additional filter", async () => {
    // `stack_id` names the Stack; `domain` narrows the query and never replaces it.
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_CONTEXT_RESPONSE,
    });
    await callTool(
      "query_stack",
      { query: "q", domain: "dom", stack_id: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );
    expect(requests[0]?.body).toBe(
      `{"query":"q","max_entities":8,"stack_id":"${STACK}","domain":"dom"}`,
    );
  });

  it("uses stack_id when domain is absent", async () => {
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_CONTEXT_RESPONSE,
    });
    await callTool(
      "query_stack",
      { query: "q", stack_id: "00000000-0000-4000-8000-000000000000", max_entities: 3 },
      { fetchImpl, baseUrl: BASE_URL },
    );
    expect(requests[0]?.body).toBe(
      '{"query":"q","max_entities":3,"stack_id":"00000000-0000-4000-8000-000000000000"}',
    );
  });

  it("refuses a call with no stack argument and issues no request", async () => {
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: "{}" });
    // Each tool's other required argument is supplied so the missing-Stack branch
    // is the one under test, matching the Python's order: `args["query"]` is read
    // first, then the Stack check.
    const required: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["query_stack", { query: "q" }],
      ["traverse_stack", { start: "X" }],
      ["get_entities", {}],
    ];
    for (const [tool, args] of required) {
      const result = await callTool(tool, args, { fetchImpl, baseUrl: BASE_URL });
      expect(textOf(result), tool).toBe(MISSING_STACK_TEXT);
    }
    expect(requests).toHaveLength(0);
  });

  it("refuses a domain-only call and issues no request", async () => {
    // `domain` is a filter, not a Stack identity: it cannot stand in for
    // `stack_id`, and a refusal that still fired a request would be a bug.
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: "{}" });
    const domainOnly: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["query_stack", { query: "q", domain: "w1doc-probe-main" }],
      ["traverse_stack", { start: "X", domain: "w1doc-probe-main" }],
      ["get_entities", { domain: "w1doc-probe-main" }],
    ];
    for (const [tool, args] of domainOnly) {
      const result = await callTool(tool, args, { fetchImpl, baseUrl: BASE_URL });
      expect(textOf(result), tool).toBe(MISSING_STACK_TEXT);
    }
    expect(requests).toHaveLength(0);
  });

  it("raises on a missing required argument, like the Python's `args[key]`", async () => {
    // `query_stack` with no `query` is a KeyError in Python, not a request
    // with a null query. `callTool` is exported, so this is reachable.
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: "{}" });
    await expect(
      callTool("query_stack", { domain: "d" }, { fetchImpl, baseUrl: BASE_URL }),
    ).rejects.toThrow("KeyError: 'query'");
    await expect(
      callTool("traverse_stack", { domain: "d" }, { fetchImpl, baseUrl: BASE_URL }),
    ).rejects.toThrow("KeyError: 'start'");
    expect(requests).toHaveLength(0);
  });

  it("GETs traverse_stack to /aks/v1/traverse with httpx-encoded params", async () => {
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_TRAVERSE_RESPONSE,
    });
    const result = await callTool(
      "traverse_stack",
      { start: "Payment Service", stack_id: STACK, relationship_types: "requires,triggers" },
      { fetchImpl, baseUrl: BASE_URL },
    );

    expect(requests[0]?.method).toBe("GET");
    // Param order follows the Python dict: start, max_depth, then the Stack,
    // then relationship_types.
    expect(requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/traverse?start=Payment+Service&max_depth=2&stack_id=${STACK}&relationship_types=requires%2Ctriggers`,
    );
    expect(textOf(result)).toBe(EXPECTED_TRAV);
  });

  it("GETs get_entities to /aks/v1/entities with min_confidence first", async () => {
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_ENTITIES_RESPONSE,
    });
    const result = await callTool(
      "get_entities",
      { stack_id: STACK, type: "System" },
      { fetchImpl, baseUrl: BASE_URL },
    );

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/entities?min_confidence=0.0&limit=100&stack_id=${STACK}&type=System`,
    );
    expect(textOf(result)).toBe(EXPECTED_ENTS);
  });

  it("builds query strings byte-identical to httpx for full argument sets", async () => {
    // Expected URLs produced by httpx 0.28.1 from the exact param dicts the
    // Python builds (``httpx.URL(base, params={...})``), not by hand.
    const traverse = recordingFetch({ status: 200, body: SYNTHETIC_TRAVERSE_RESPONSE });
    await callTool(
      "traverse_stack",
      {
        start: "Payment Service",
        max_depth: 2,
        stack_id: STACK,
        relationship_types: "requires,triggers",
      },
      { ...traverse, baseUrl: BASE_URL },
    );
    expect(traverse.requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/traverse?start=Payment+Service&max_depth=2&stack_id=${STACK}&relationship_types=requires%2Ctriggers`,
    );

    const entities = recordingFetch({ status: 200, body: SYNTHETIC_ENTITIES_RESPONSE });
    await callTool(
      "get_entities",
      { stack_id: STACK, type: "System" },
      { ...entities, baseUrl: BASE_URL },
    );
    // min_confidence is a Python float (0.0), limit a Python int (100).
    expect(entities.requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/entities?min_confidence=0.0&limit=100&stack_id=${STACK}&type=System`,
    );
  });

  it("GETs list_stacks to /stacks — no /aks/v1 prefix", async () => {
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    const result = await callTool("list_stacks", {}, { fetchImpl, baseUrl: BASE_URL });

    expect(requests[0]?.method).toBe("GET");
    // The one Stack endpoint outside the /aks/v1 prefix. A port that "tidied"
    // this to /aks/v1/stacks would 404 against the real server.
    expect(requests[0]?.url).toBe("http://localhost:8000/stacks");
    expect(textOf(result)).toBe(EXPECTED_STACKS);
  });

  it("forwards the X-API-Key header only when configured", async () => {
    const withKey = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    await callTool("list_stacks", {}, { ...withKey, baseUrl: BASE_URL, apiKey: "k-123" });
    expect(withKey.requests[0]?.headers["X-API-Key"]).toBe("k-123");

    const withoutKey = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    await callTool("list_stacks", {}, { ...withoutKey, baseUrl: BASE_URL, apiKey: "" });
    expect(Object.hasOwn(withoutKey.requests[0]?.headers ?? {}, "X-API-Key")).toBe(false);
  });

  it("sends the API key on the POST tool too", async () => {
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_CONTEXT_RESPONSE,
    });
    await callTool(
      "query_stack",
      { query: "q", stack_id: STACK },
      { fetchImpl, baseUrl: BASE_URL, apiKey: "k-123" },
    );
    expect(requests[0]?.headers["X-API-Key"]).toBe("k-123");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("renders a non-200 response as `AKS server returned <status>: <body>`", async () => {
    // Uses the REAL 404 body the oracle returns for an unknown traverse entity.
    const { fetchImpl } = recordingFetch({ status: 404, body: ORACLE_TRAVERSE_404_BODY });
    const result = await callTool(
      "traverse_stack",
      { start: "Nope", stack_id: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );
    expect(textOf(result)).toBe(
      `AKS server returned 404: ${ORACLE_TRAVERSE_404_BODY}`,
    );
  });

  it("passes through a 500 body verbatim, including a non-JSON one", async () => {
    // Real oracle behaviour: POST /aks/v1/context returns plain text
    // "Internal Server Error" when LLM credentials are missing.
    const { fetchImpl } = recordingFetch({ status: 500, body: "Internal Server Error" });
    const result = await callTool(
      "query_stack",
      { query: "q", stack_id: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );
    expect(textOf(result)).toBe("AKS server returned 500: Internal Server Error");
  });

  it("honours AKS_BASE_URL by concatenation, preserving a trailing slash", async () => {
    // Python does f"{AKS_BASE_URL}/aks/v1/...", so a trailing slash yields "//".
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    await callTool("list_stacks", {}, { fetchImpl, baseUrl: "http://host:9000/" });
    expect(requests[0]?.url).toBe("http://host:9000//stacks");
  });
});
