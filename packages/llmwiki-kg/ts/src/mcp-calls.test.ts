/**
 * @file packages/llmwiki-kg/ts/src/mcp-calls.test.ts
 * @description `callTool` routing against a stubbed fetch.
 */

import { describe, expect, it } from "vitest";
import { callTool } from "./mcp.js";
import { stackIdProblem } from "./stack-id.js";
import {
  BASE_URL,
  CONTRACT_STACK_KEYS,
  EXPECTED_CTX,
  EXPECTED_ENTS,
  EXPECTED_TRAV,
  ORACLE_STACKS_BODY,
  ORACLE_TRAVERSE_404_BODY,
  SYNTHETIC_CONTEXT_RESPONSE,
  SYNTHETIC_ENTITIES_RESPONSE,
  SYNTHETIC_TRAVERSE_RESPONSE,
  payloadOf,
  recordingFetch,
  textOf,
} from "./mcp-harness.js";

/** A Stack id with the canonical lowercase-UUID shape the API accepts. */
const STACK = "20efd96a-f6e1-4994-8812-65113f8db4db";

/**
 * The decoded `list_stacks` envelope, as a client parses it.
 */
interface StacksPayload {
  readonly stacks: ReadonlyArray<Record<string, unknown>>;
  readonly count: number;
}

/** The refusal every graph tool answers when the Stack argument is absent. */
const MISSING_STACK_TEXT = "Error: 'stackId' must be provided.";

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
      { query: "how are refunds handled?", stackId: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("http://localhost:8000/aks/v1/context");
    // `max_entities` defaults to 8; the Stack is forwarded as the argument gave it.
    expect(request?.body).toBe(`{"query":"how are refunds handled?","max_entities":8,"stackId":"${STACK}"}`);
    expect(textOf(result)).toBe(EXPECTED_CTX);
  });

  it("forwards stackId and passes domain only as an additional filter", async () => {
    // `stackId` names the Stack; `domain` narrows the query and never replaces it.
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_CONTEXT_RESPONSE,
    });
    await callTool(
      "query_stack",
      { query: "q", domain: "dom", stackId: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );
    expect(requests[0]?.body).toBe(
      `{"query":"q","max_entities":8,"stackId":"${STACK}","domain":"dom"}`,
    );
  });

  it("uses stackId when domain is absent", async () => {
    const { fetchImpl, requests } = recordingFetch({
      status: 200,
      body: SYNTHETIC_CONTEXT_RESPONSE,
    });
    await callTool(
      "query_stack",
      { query: "q", stackId: "00000000-0000-4000-8000-000000000000", max_entities: 3 },
      { fetchImpl, baseUrl: BASE_URL },
    );
    expect(requests[0]?.body).toBe(
      '{"query":"q","max_entities":3,"stackId":"00000000-0000-4000-8000-000000000000"}',
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
      // The refusal is an error envelope: text alone cannot be told apart from
      // an answer by a client that only reads `isError`.
      expect(result.isError, tool).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });

  it("refuses a domain-only call and issues no request", async () => {
    // `domain` is a filter, not a Stack identity: it cannot stand in for
    // `stackId`, and a refusal that still fired a request would be a bug.
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: "{}" });
    const domainOnly: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["query_stack", { query: "q", domain: "w1doc-probe-main" }],
      ["traverse_stack", { start: "X", domain: "w1doc-probe-main" }],
      ["get_entities", { domain: "w1doc-probe-main" }],
    ];
    for (const [tool, args] of domainOnly) {
      const result = await callTool(tool, args, { fetchImpl, baseUrl: BASE_URL });
      expect(textOf(result), tool).toBe(MISSING_STACK_TEXT);
      expect(result.isError, tool).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });

  it("keeps answers and backend error text as ordinary results, not error envelopes", async () => {
    // The refusal above is the ONLY path that became an error envelope. An
    // answer that reached the backend, and the status text a non-200 produces,
    // both stay plain results, exactly as before.
    const answered = recordingFetch({ status: 200, body: SYNTHETIC_CONTEXT_RESPONSE });
    const ok = await callTool(
      "query_stack",
      { query: "q", stackId: STACK },
      { fetchImpl: answered.fetchImpl, baseUrl: BASE_URL },
    );
    expect(textOf(ok)).toBe(EXPECTED_CTX);
    expect(ok.isError).toBeUndefined();

    const failed = recordingFetch({ status: 500, body: "Internal Server Error" });
    const status = await callTool(
      "query_stack",
      { query: "q", stackId: STACK },
      { fetchImpl: failed.fetchImpl, baseUrl: BASE_URL },
    );
    expect(textOf(status)).toBe("AKS server returned 500: Internal Server Error");
    expect(status.isError).toBeUndefined();
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
      { start: "Payment Service", stackId: STACK, relationship_types: "requires,triggers" },
      { fetchImpl, baseUrl: BASE_URL },
    );

    expect(requests[0]?.method).toBe("GET");
    // Param order follows the Python dict: start, max_depth, then the Stack,
    // then relationship_types.
    expect(requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/traverse?start=Payment+Service&max_depth=2&stackId=${STACK}&relationship_types=requires%2Ctriggers`,
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
      { stackId: STACK, type: "System" },
      { fetchImpl, baseUrl: BASE_URL },
    );

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/entities?min_confidence=0.0&limit=100&stackId=${STACK}&type=System`,
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
        stackId: STACK,
        relationship_types: "requires,triggers",
      },
      { ...traverse, baseUrl: BASE_URL },
    );
    expect(traverse.requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/traverse?start=Payment+Service&max_depth=2&stackId=${STACK}&relationship_types=requires%2Ctriggers`,
    );

    const entities = recordingFetch({ status: 200, body: SYNTHETIC_ENTITIES_RESPONSE });
    await callTool(
      "get_entities",
      { stackId: STACK, type: "System" },
      { ...entities, baseUrl: BASE_URL },
    );
    // min_confidence is a Python float (0.0), limit a Python int (100).
    expect(entities.requests[0]?.url).toBe(
      `http://localhost:8000/aks/v1/entities?min_confidence=0.0&limit=100&stackId=${STACK}&type=System`,
    );
  });

  it("GETs list_stacks to /stacks and answers the contract envelope", async () => {
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    const result = await callTool("list_stacks", {}, { fetchImpl, baseUrl: BASE_URL });

    expect(requests[0]?.method).toBe("GET");
    // The one Stack endpoint outside the /aks/v1 prefix. A port that "tidied"
    // this to /aks/v1/stacks would 404 against the real server.
    expect(requests[0]?.url).toBe("http://localhost:8000/stacks");

    const payload = payloadOf(result) as StacksPayload;
    // Exactly two keys, in this order: `stacks`, then `count`.
    expect(Object.keys(payload)).toEqual(["stacks", "count"]);
    expect(payload.count).toBe(payload.stacks.length);
    // Every entry carries exactly the ten contract keys, in contract order.
    for (const stack of payload.stacks) {
      expect(Object.keys(stack)).toEqual([...CONTRACT_STACK_KEYS]);
    }
  });

  it("marks the Stack it was given current, and sorts it ahead of recency", async () => {
    const { fetchImpl } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    // `STACK` is the OLDEST entry in the recorded body, i.e. last by `updated_at`:
    // mark-current has to survive recency ordering, not ride along with it.
    const result = await callTool(
      "list_stacks",
      { stackId: STACK },
      { fetchImpl, baseUrl: BASE_URL },
    );

    const payload = payloadOf(result) as StacksPayload;
    // Current first, the rest most-recently-updated first: the named entry is
    // the oldest, so recency alone would have put it LAST.
    expect(payload.stacks.map((stack) => stack["id"])).toEqual([
      STACK,
      "1146a0e7-dc44-4eac-bd62-606549aa86ce",
      "b6c9fd8b-205f-4f5e-b482-7b540e616c86",
    ]);
    // Exactly one entry is current, and every other entry is false rather than absent.
    expect(payload.stacks.filter((stack) => stack["isCurrent"] === true)).toHaveLength(1);
    expect(payload.stacks[0]?.["isCurrent"]).toBe(true);
  });

  it("marks nothing current when stackId is omitted, and is not refused", async () => {
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    const result = await callTool("list_stacks", {}, { fetchImpl, baseUrl: BASE_URL });

    // The exemption, pinned: a discovery tool cannot demand the id it discovers.
    expect(result.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    const payload = payloadOf(result) as StacksPayload;
    // This dimension is bound to no Stack, so an omission marks none.
    expect(payload.stacks.filter((stack) => stack["isCurrent"] === true)).toHaveLength(0);
  });

  it("reaches HTTP with a well-formed stackId and refuses a malformed one first", async () => {
    const answered = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    await callTool("list_stacks", { stackId: STACK }, { fetchImpl: answered.fetchImpl, baseUrl: BASE_URL });
    expect(answered.requests).toHaveLength(1);
    expect(answered.requests[0]?.url).toBe("http://localhost:8000/stacks");

    const refused = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    const refusal = await callTool(
      "list_stacks",
      { stackId: "not-a-uuid" },
      { fetchImpl: refused.fetchImpl, baseUrl: BASE_URL },
    );
    // A malformed id is refused BEFORE the hop, so nothing unusable reaches the backend.
    expect(refusal.isError).toBe(true);
    expect(refused.requests).toHaveLength(0);
  });

  it("states the Stack-id rule once, from the shared validator", async () => {
    const { fetchImpl } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
    const malformed = "not-a-uuid";
    const result = await callTool(
      "get_entities",
      { stackId: malformed },
      { fetchImpl, baseUrl: BASE_URL },
    );

    // One source of the wording: the shared rule, prefixed with "Error: ". The
    // earlier composed prefix stated the UUID rule twice (T2 follow-up).
    expect(textOf(result)).toBe(`Error: ${stackIdProblem(malformed)}`);
    expect(textOf(result)).not.toContain("must be a UUID");
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
      { query: "q", stackId: STACK },
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
      { start: "Nope", stackId: STACK },
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
      { query: "q", stackId: STACK },
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
