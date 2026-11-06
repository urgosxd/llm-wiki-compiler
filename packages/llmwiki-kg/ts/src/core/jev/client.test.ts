/**
 * @file packages/llmwiki-kg/ts/src/core/jev/client.test.ts
 * @description The HTTP adapter's wire contract and its retry discipline.
 *
 * WHY THIS FILE EXISTS. Two properties cannot be observed anywhere else: that the
 * request on the wire is the documented `POST {baseUrl}/v1/systemone` with bearer
 * auth and `{ model, state, questions }`, and that the retry policy spends its
 * budget on transient failures only. A 401 retried three times is a lockout, and a
 * 503 given up on after one try is a lost document, so both counts are asserted.
 *
 * NO NETWORK. Every test injects `fetchImpl`; the default suite never reaches the
 * vendor and never needs a credential.
 */

import { describe, expect, it } from "vitest";

import { TRANSIENT_ATTEMPTS } from "../llm/retry.js";
import { createJevHttpClient, requestDecision } from "./client.js";
import type { JevFetch } from "./client.js";
import type { JevDecisionRequest } from "./types.js";

const REQUEST: JevDecisionRequest = {
  model: "jev-test",
  state: "candidate block",
  questions: {
    answerable: { type: "noul", instructions: "Does it fit?", criteria: { true: "yes", false: "no" } },
  },
};

const VALID_BODY = {
  model: "jev-test",
  answers: { answerable: { type: "noul", noul: 0.83 } },
  usage: { total_tokens: 12 },
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl: JevFetch): ReturnType<typeof createJevHttpClient> {
  return createJevHttpClient({
    baseUrl: "https://jev.test",
    apiKey: "sk-test",
    timeoutMs: 1_000,
    fetchImpl,
    sleep: async () => undefined,
  });
}

function countingFetch(response: () => Response): { calls: Call[]; fetchImpl: JevFetch } {
  const calls: Call[] = [];
  const fetchImpl: JevFetch = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetchImpl };
}

describe("createJevHttpClient — the wire contract", () => {
  it("posts { model, state, questions } to /v1/systemone with the bearer credential", async () => {
    const recorder = countingFetch(() => jsonResponse(VALID_BODY));
    const outcome = await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call?.url).toBe("https://jev.test/v1/systemone");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual(REQUEST);
    expect(outcome.status).toBe("answered");
    expect(outcome.status === "answered" ? outcome.response.answers["answerable"] : undefined).toEqual({
      type: "noul",
      noul: 0.83,
    });
  });

  it("sends the bearer credential and an abort signal so a hung request cannot hang ingestion", async () => {
    const recorder = countingFetch(() => jsonResponse(VALID_BODY));
    await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    const init = recorder.calls[0]?.init;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createJevHttpClient — retries stop where they must", () => {
  it("stops after one attempt on 401, because a bad credential never fixes itself", async () => {
    const recorder = countingFetch(() => jsonResponse({ error: { message: "unauthorized" } }, 401));
    const outcome = await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    expect(recorder.calls).toHaveLength(1);
    expect(outcome.status).toBe("provider_failure");
    expect(outcome.status === "provider_failure" ? outcome.kind : undefined).toBe("provider_answered");
    expect(outcome.status === "provider_failure" ? outcome.state : undefined).toBe("failed");
  });

  it("stops after one attempt on 400, because a malformed request never fixes itself", async () => {
    const recorder = countingFetch(() => jsonResponse({ error: { message: "bad request" } }, 400));
    const outcome = await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    expect(recorder.calls).toHaveLength(1);
    expect(outcome.status === "provider_failure" ? outcome.state : undefined).toBe("failed");
  });

  it("retries a 503 up to the bound and then reports an exhausted provider", async () => {
    const recorder = countingFetch(() => jsonResponse({ error: { message: "unavailable" } }, 503));
    const outcome = await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    expect(recorder.calls).toHaveLength(TRANSIENT_ATTEMPTS);
    expect(outcome.status).toBe("provider_failure");
    expect(outcome.status === "provider_failure" ? outcome.kind : undefined).toBe("provider_failed");
    expect(outcome.status === "provider_failure" ? outcome.state : undefined).toBe("pending");
  });

  it("retries a transport failure up to the bound and never reports a decision", async () => {
    let attempts = 0;
    const fetchImpl: JevFetch = async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    };
    const outcome = await requestDecision(clientWith(fetchImpl), REQUEST);
    expect(attempts).toBe(TRANSIENT_ATTEMPTS);
    expect(outcome.status === "provider_failure" ? outcome.state : undefined).toBe("pending");
  });
});

describe("createJevHttpClient — unusable payloads", () => {
  it("treats a malformed 200 payload as an operational failure rather than a decision", async () => {
    const recorder = countingFetch(() => jsonResponse({ model: "jev-test", answers: { answerable: { type: "choice" } } }));
    const outcome = await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    expect(outcome.status).toBe("provider_failure");
    expect(outcome.status === "provider_failure" ? outcome.kind : undefined).toBe("invalid_response");
    expect(outcome.status === "provider_failure" ? outcome.state : undefined).toBe("failed");
  });

  it("treats a body that is not JSON as an operational failure", async () => {
    const recorder = countingFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const outcome = await requestDecision(clientWith(recorder.fetchImpl), REQUEST);
    expect(outcome.status).toBe("provider_failure");
    expect(outcome.status === "provider_failure" ? outcome.kind : undefined).toBe("invalid_response");
  });
});
