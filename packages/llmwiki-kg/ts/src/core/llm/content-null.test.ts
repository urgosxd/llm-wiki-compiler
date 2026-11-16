/**
 * @file packages/llmwiki-kg/ts/src/core/llm/content-null.test.ts
 * @description What an OpenAI-compatible body with `content: null` means, and the
 * budget that produced it.
 *
 * WHY THIS FILE EXISTS. Measured against OpenRouter with a realistic 8.3 kB
 * extraction prompt: at `max_tokens: 1024` every response came back
 * `finish_reason: "length"` with `choices[0].message.content === null` (0 of 8
 * usable), while at 4096 eight of eight answered with at most 748 reasoning
 * tokens. The upstream was healthy throughout — HTTP 200 in 46 of 46 calls, no
 * 429 — so nothing about the provider was wrong; the budget was, and the route
 * answered a bare `text/plain` 21-byte `Internal Server Error` because the
 * resulting `LlmError` carried no status.
 *
 * Three properties are pinned here, and the third deliberately pins BEHAVIOUR
 * rather than the number 4096: an adequate budget is one that covers the measured
 * reasoning spend plus the answer the call must produce, whatever value carries
 * it.
 *
 * The route cases drive the real HTTP surface (`POST /aks/v1/context`) against
 * the per-run database, with only the provider stubbed: a truncated answer is not
 * something a live model can be asked to produce on cue.
 *
 * The last four route cases pin the RETRY, and its boundary is the point: an
 * exhausted budget is repeated exactly once with a strictly larger derived budget
 * and then reported, while a failure of any other class is not repeated at all.
 * That scoping is only expressible because the budget failure is its own error
 * class; without it the route could either retry every failure (spending the
 * request again on an outage a larger budget cannot fix) or none.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { toVectorLiteral } from "../retrieval.js";
import { chatMessageContent } from "./complete.js";
import { SELECTION_MAX_TOKENS, SELECTION_RETRY_MAX_TOKENS } from "../../routes/aks/context.js";
import {
  createFixture,
  createTestApp,
  database,
  deleteFixtureRows,
  state,
  useDomainPrefix,
} from "../../routes/aks-harness.js";
import type { Fixture } from "../../routes/aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("budget");

/** Never resolvable, never routed: no assertion here can reach a real service. */
const ENDPOINT = "https://chat.invalid/v1/chat/completions";

/** A completion that ran out of budget before the model wrote anything. */
const TRUNCATED_COMPLETION = {
  choices: [{ message: { content: null }, finish_reason: "length" }],
};

/** A selection answer the route can parse, so a retried call can succeed. */
const SELECTION_COMPLETION = {
  choices: [
    {
      message: {
        content: '{"entity_names":["Gateway"],"reasoning":"named in the passage","confidence":"HIGH"}',
      },
      finish_reason: "stop",
    },
  ],
};

/** A 200 body with no completion at all: a plain, status-less `LlmError`. */
const UNKNOWN_COMPLETION = { choices: [] };

/** Reasoning tokens measured at a 4096 budget: the floor an adequate one must cover. */
const MEASURED_REASONING_TOKENS = 748;

/** The answer the selection call must produce: a small JSON object. */
const SELECTION_ANSWER_TOKENS = 1024;

/** The chunk dimension `db/schema.sql` declares. */
const EMBEDDING_DIM = 768;

/** One unit vector, so the query embedding matches the seeded chunk exactly. */
const QUERY_VECTOR = Array.from({ length: EMBEDDING_DIM }, (_, index) => (index === 0 ? 1 : 0));

/** Shares vocabulary with {@link QUERY}, so retrieval scores the chunk. */
const CHUNK_TEXT =
  "The Gateway routes embedding traffic; the Embedding Model caps throughput with a Rate Limit.";

/** The question every route case asks. */
const QUERY = "how does the gateway route embedding traffic";

/** The thrown error, so one case can assert several of its properties. */
function errorFrom(action: () => unknown): Error & { status?: number } {
  try {
    action();
  } catch (error) {
    return error as Error & { status?: number };
  }
  throw new Error("expected the call to throw");
}

/** A 200 JSON answer, shaped like what `postJson` reads. */
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/**
 * Answers every provider call locally and records the chat bodies that were sent.
 *
 * The chat bodies are a SEQUENCE, one per call, the last one repeating: a retry
 * test needs a different answer for the second call than for the first, and the
 * recorded requests are how a test counts the calls a route actually made.
 */
function stubProvider(...chatBodies: unknown[]): { chatRequests: readonly Record<string, unknown>[] } {
  const chatRequests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith("/embeddings")) {
      return okResponse({ data: [{ index: 0, embedding: QUERY_VECTOR }] });
    }
    chatRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return okResponse(chatBodies[Math.min(chatRequests.length - 1, chatBodies.length - 1)]);
  });
  return { chatRequests };
}

/** A Stack whose one chunk matches the stub query vector, so the route reaches the model. */
async function seedReachableStack(): Promise<Fixture> {
  const fixture = await createFixture();
  await database().execute(sql`
    insert into document_chunks (
      id, document_id, stack_id, chunk_index, content, content_hash, token_count, embedding
    )
    values (
      ${randomUUID()}, ${fixture.documentId}, ${fixture.stackId}, 0,
      ${CHUNK_TEXT}, ${randomUUID()}, ${16}, ${toVectorLiteral(QUERY_VECTOR)}::vector
    )
  `);
  return fixture;
}

describe("a completion that ran out of budget", () => {
  it("is reported as a budget failure, not as an unknown one", () => {
    const thrown = errorFrom(() => chatMessageContent(TRUNCATED_COMPLETION, ENDPOINT));

    expect(thrown.message).toMatch(/budget/i);
  });

  it("carries an explicit status, so a client can tell it from a provider failure", () => {
    // "Provider down" is the transport path, which raises a status-less error:
    // that difference is the whole distinguishing signal a caller has.
    const budget = errorFrom(() => chatMessageContent(TRUNCATED_COMPLETION, ENDPOINT));
    const unknownResponse = errorFrom(() => chatMessageContent({}, ENDPOINT));

    expect(budget.status).toBeTypeOf("number");
    expect(unknownResponse.status).toBeUndefined();
  });
});

describe.skipIf(state.skipReason !== false)("POST /aks/v1/context under an exhausted budget", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("answers a legible error instead of the opaque 21-byte 500", async () => {
    stubProvider(TRUNCATED_COMPLETION);
    const fixture = await seedReachableStack();

    const response = await request(createTestApp())
      .post("/aks/v1/context")
      .send({ domain: fixture.domain, query: QUERY });

    expect(response.status).toBe(502);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(String(response.body.detail)).toMatch(/budget/i);
    expect(response.text).not.toBe("Internal Server Error");
  });

  it("asks the provider for a budget the call can actually finish inside", async () => {
    const provider = stubProvider(TRUNCATED_COMPLETION);
    const fixture = await seedReachableStack();

    await request(createTestApp())
      .post("/aks/v1/context")
      .send({ domain: fixture.domain, query: QUERY });

    const [chat] = provider.chatRequests;
    const budget = Number(chat?.["max_tokens"]);
    // Adequate means the measured reasoning spend plus the answer the call must
    // produce; the number that carries it is deliberately not pinned here.
    expect(budget).toBeGreaterThanOrEqual(MEASURED_REASONING_TOKENS + SELECTION_ANSWER_TOKENS);
  });
});

/**
 * The retry, and its boundary.
 *
 * One escalation on the budget class alone is what turns a legible failure into a
 * recovering one without also repeating a provider outage, which no larger budget
 * can fix.
 */
describe.skipIf(state.skipReason !== false)("POST /aks/v1/context: one escalation", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("retries once at a strictly larger budget, and the retry answers", async () => {
    const provider = stubProvider(TRUNCATED_COMPLETION, SELECTION_COMPLETION);
    const fixture = await seedReachableStack();
    const response = await request(createTestApp())
      .post("/aks/v1/context")
      .send({ domain: fixture.domain, query: QUERY });

    // The escalation answers the request the first attempt could not.
    expect(response.status).toBe(200);
    expect(provider.chatRequests).toHaveLength(2);
    // The relationship, not the literal: larger than the budget that ran out, and
    // exactly the derived escalation constant.
    const retryBudget = Number(provider.chatRequests[1]?.["max_tokens"]);
    expect(retryBudget).toBeGreaterThan(SELECTION_MAX_TOKENS);
    expect(retryBudget).toBe(SELECTION_RETRY_MAX_TOKENS);
  });

  it("fails after the one retry instead of looping", async () => {
    const provider = stubProvider(TRUNCATED_COMPLETION);
    const fixture = await seedReachableStack();
    const response = await request(createTestApp())
      .post("/aks/v1/context")
      .send({ domain: fixture.domain, query: QUERY });

    expect(response.status).toBe(502);
    // Two calls: the original attempt and its single escalation, never a third.
    expect(provider.chatRequests).toHaveLength(2);
  });
});

/**
 * What the escalation must NOT touch.
 *
 * The class boundary is the entire justification for retrying at all, so the
 * negative case is pinned as tightly as the positive one: an outage and a
 * first-attempt success both stay at one call.
 */
describe.skipIf(state.skipReason !== false)("POST /aks/v1/context: retry scope", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("does not retry a failure of any other class", async () => {
    // No completion at all is a plain status-less `LlmError`, the shape a provider
    // outage leaves. A larger budget cannot fix it, so a repeat would only spend
    // the request again and report the wrong system.
    const provider = stubProvider(UNKNOWN_COMPLETION);
    const fixture = await seedReachableStack();
    const response = await request(createTestApp())
      .post("/aks/v1/context")
      .send({ domain: fixture.domain, query: QUERY });

    expect(response.status).toBe(500);
    expect(provider.chatRequests).toHaveLength(1);
  });

  it("makes one call when the first attempt already answers", async () => {
    const provider = stubProvider(SELECTION_COMPLETION);
    const fixture = await seedReachableStack();
    const response = await request(createTestApp())
      .post("/aks/v1/context")
      .send({ domain: fixture.domain, query: QUERY });

    expect(response.status).toBe(200);
    expect(provider.chatRequests).toHaveLength(1);
  });
});
