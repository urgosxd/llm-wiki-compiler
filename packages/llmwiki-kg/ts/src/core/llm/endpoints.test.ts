/**
 * @file packages/llmwiki-kg/ts/src/core/llm/endpoints.test.ts
 * @description Where the chat request and the embedding request are actually sent.
 *
 * WHY THIS FILE EXISTS. One variable, `GATEWAY_URL`, used to resolve BOTH the
 * chat-completions endpoint and the embeddings endpoint. A deployment whose two
 * services live on different hosts could satisfy one of them and not the other:
 * extraction could not reach its model, or embeddings were posted to the chat
 * host. The question this file answers is therefore the RESOLVED endpoint, not
 * the absence of an error — a configuration that silently sends both requests to
 * the same host passes every "did it start" check and still fails in production.
 *
 * The fixtures are `.invalid` hosts (RFC 6761: never resolvable, never routed),
 * so no assertion here can reach a real service, and the keys are obviously fake
 * literals.
 *
 * `config` is a lazily-resolved singleton, so each case stubs the environment
 * and imports `endpoints.js` again after `vi.resetModules()`: the fresh singleton
 * reads the stubbed environment on its first property read, which is the read
 * `extractionEndpoint()`/`embeddingEndpoint()` performs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Chat host fixture: never resolves. */
const CHAT_HOST = "https://chat.invalid/api/v1";
/** Embeddings host fixture: never resolves, and a different host from {@link CHAT_HOST}. */
const EMBED_HOST = "https://embed.invalid/openai/v1";

/**
 * Environment every case starts from.
 *
 * Both provider selectors are pinned to `gateway` and every gateway variable is
 * blanked, so a case states exactly the values it is about. The wiki-side names
 * are blanked too: `bridgeEnvWithWikiCredentials()` fills a blank `GATEWAY_URL`
 * from `OPENAI_EMBEDDINGS_BASE_URL`/`OPENAI_BASE_URL`, so an inherited shell
 * value would otherwise decide the assertion.
 */
const BASELINE: NodeJS.ProcessEnv = {
  EXTRACTION_PROVIDER: "gateway",
  EMBEDDING_PROVIDER: "gateway",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
  GATEWAY_EMBEDDINGS_BASE_URL: "",
  GATEWAY_EMBEDDINGS_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_EMBEDDINGS_BASE_URL: "",
  OPENAI_EMBEDDINGS_API_KEY: "",
  LLMWIKI_PROVIDER: "",
  LLMWIKI_EMBEDDING_PROVIDER: "",
};

/** The module under test, as imported against one environment. */
type Endpoints = typeof import("./endpoints.js");

/**
 * Imports `endpoints.js` against {@link BASELINE} overlaid with `overrides`.
 *
 * @param overrides - Variables this case is about.
 * @returns A fresh module instance bound to a fresh config singleton.
 */
async function endpointsWith(overrides: NodeJS.ProcessEnv): Promise<Endpoints> {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...BASELINE, ...overrides })) {
    vi.stubEnv(name, value ?? "");
  }
  return import("./endpoints.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("two gateway hosts resolve independently (S1, S3, S4)", () => {
  it("sends chat to the gateway host and embeddings to the embeddings host", async () => {
    const endpoints = await endpointsWith({
      GATEWAY_URL: CHAT_HOST,
      GATEWAY_API_KEY: "chat-key",
      GATEWAY_EMBEDDINGS_BASE_URL: EMBED_HOST,
      GATEWAY_EMBEDDINGS_API_KEY: "embed-key",
    });

    expect(endpoints.extractionEndpoint()).toEqual({
      endpoint: `${CHAT_HOST}/chat/completions`,
      apiKey: "chat-key",
    });
    expect(endpoints.embeddingEndpoint()).toEqual({
      endpoint: `${EMBED_HOST}/embeddings`,
      apiKey: "embed-key",
    });
    expect(endpoints.extractionEndpoint().endpoint).not.toBe(
      endpoints.embeddingEndpoint().endpoint,
    );
  });
});

describe("the single-variable path every existing deployment uses (S2)", () => {
  it("resolves both requests exactly as the one gateway variable did", async () => {
    const endpoints = await endpointsWith({
      GATEWAY_URL: CHAT_HOST,
      GATEWAY_API_KEY: "chat-key",
    });

    expect(endpoints.extractionEndpoint()).toEqual({
      endpoint: `${CHAT_HOST}/chat/completions`,
      apiKey: "chat-key",
    });
    expect(endpoints.embeddingEndpoint()).toEqual({
      endpoint: `${CHAT_HOST}/embeddings`,
      apiKey: "chat-key",
    });
  });
});

describe("an unset embeddings variable inherits the gateway one (S3, S4)", () => {
  it("takes the embeddings endpoint from the gateway URL when only the key is split", async () => {
    const endpoints = await endpointsWith({
      GATEWAY_URL: CHAT_HOST,
      GATEWAY_API_KEY: "chat-key",
      GATEWAY_EMBEDDINGS_API_KEY: "embed-key",
    });

    expect(endpoints.embeddingEndpoint()).toEqual({
      endpoint: `${CHAT_HOST}/embeddings`,
      apiKey: "embed-key",
    });
    expect(endpoints.extractionEndpoint().apiKey).toBe("chat-key");
  });

  it("takes the embeddings credential from the gateway key when only the URL is split", async () => {
    const endpoints = await endpointsWith({
      GATEWAY_URL: CHAT_HOST,
      GATEWAY_API_KEY: "chat-key",
      GATEWAY_EMBEDDINGS_BASE_URL: EMBED_HOST,
    });

    expect(endpoints.embeddingEndpoint()).toEqual({
      endpoint: `${EMBED_HOST}/embeddings`,
      apiKey: "chat-key",
    });
  });

  it("treats a whitespace-only embeddings URL as unset, not as a host", async () => {
    // The schema trims this variable, so spaces are not a setting. A fallback
    // written as a truthiness check on the raw value would post to "   /embeddings".
    const endpoints = await endpointsWith({
      GATEWAY_URL: CHAT_HOST,
      GATEWAY_API_KEY: "chat-key",
      GATEWAY_EMBEDDINGS_BASE_URL: "   ",
    });

    expect(endpoints.embeddingEndpoint().endpoint).toBe(`${CHAT_HOST}/embeddings`);
  });
});

describe("the non-gateway arms are untouched by the split", () => {
  it("resolves anthropic chat and openai embeddings while the gateway pair is set", async () => {
    // The new variables must not leak into a provider that never read them: an
    // openai deployment keeps its own base URL and key whatever the gateway says.
    const endpoints = await endpointsWith({
      EXTRACTION_PROVIDER: "anthropic",
      EMBEDDING_PROVIDER: "openai",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      GATEWAY_URL: CHAT_HOST,
      GATEWAY_API_KEY: "chat-key",
      GATEWAY_EMBEDDINGS_BASE_URL: EMBED_HOST,
      GATEWAY_EMBEDDINGS_API_KEY: "embed-key",
    });

    const chat = endpoints.extractionEndpoint();
    expect(chat.apiKey).toBe("anthropic-key");
    expect(chat.endpoint.endsWith("/v1/messages")).toBe(true);
    expect(endpoints.embeddingEndpoint()).toEqual({
      endpoint: "https://api.openai.com/v1/embeddings",
      apiKey: "openai-key",
    });
  });
});
