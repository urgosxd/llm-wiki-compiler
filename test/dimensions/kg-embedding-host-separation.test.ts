/**
 * @file test/dimensions/kg-embedding-host-separation.test.ts
 * @description The regression test for the defect this feature exists to fix:
 * with two DIFFERENT hosts configured — a chat host and an embeddings host —
 * the kg dimension must embed against the EMBEDDINGS host with the wiki's
 * embedding model, and must never reach the chat host.
 *
 * WHY TWO HOSTS. One host for both services hides the whole class of bug: a
 * bridge or descriptor that reads `OPENAI_BASE_URL` instead of
 * `OPENAI_EMBEDDINGS_BASE_URL` still produces a well-formed request, and the
 * difference only shows up in the response. Two distinct hosts make the wiring
 * observable in the request URL itself.
 *
 * The wiring under test is the real one: the host provider factory builds the
 * provider, `describeEmbeddingBackend` reports what it resolved, and the
 * vendored request path is what posts. `fetch` is the only stub, so no socket is
 * opened; every credential is obviously fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchSpy } from "./kg-request-capture.js";
import { capturedEmbeddingRequest } from "./kg-embedding-capture.js";

/** The wiki-side embedding model, 768-wide on the host that serves it. */
const WIKI_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
/** The chat host: it must never appear in an embeddings request. */
const CHAT_HOST = "https://chat.invalid/api/v1";
/** The embeddings host: the only correct destination. */
const EMBEDDINGS_HOST = "https://embed.invalid/openai/v1";
/** Fake credentials, one per host, so a swap would be visible. */
const EMBED_KEY = "test-key-not-real-embed";
const CHAT_KEY = "test-key-not-real-chat";

/** The deployment the bridge has to serve: wiki configured, kg configured by nobody. */
const WIKI_ONLY_ENV: Record<string, string> = {
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_EMBEDDING_MODEL: WIKI_MODEL,
  OPENAI_BASE_URL: CHAT_HOST,
  OPENAI_EMBEDDINGS_BASE_URL: EMBEDDINGS_HOST,
  OPENAI_API_KEY: CHAT_KEY,
  OPENAI_EMBEDDINGS_API_KEY: EMBED_KEY,
  EMBEDDING_PROVIDER: "",
  EMBEDDING_MODEL: "",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
};

/** One well-formed embeddings payload, so the call reaches its return path. */
function embeddingsPayload(): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
    status: 200,
  });
}


/**
 * A fresh module graph, so the vendored config — resolved once, lazily — sees
 * this case's environment instead of another case's.
 */
function loadModules() {
  vi.resetModules();
  return Promise.all([
    import("../../src/utils/embedding-provider.js"),
    import("@repo/kg/core/llm/embeddings"),
    import("@repo/kg/embedding-backend"),
  ]);
}

let fetchSpy: FetchSpy;

beforeEach(() => {
  for (const [name, value] of Object.entries(WIKI_ONLY_ENV)) vi.stubEnv(name, value);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(embeddingsPayload());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Assert that the request just captured went to the wiki's embeddings host with
 * the wiki's model and credential, and never to the chat host.
 *
 * Shared by the descriptor case and the env-bridge case: they pin two different
 * paths to the SAME destination, so one copy of the expectation keeps them from
 * drifting into asserting different things.
 */
function expectRequestOnEmbeddingsHost(): void {
  const request = capturedEmbeddingRequest(fetchSpy.mock.calls[0] as unknown[]);
  expect(request.url).toBe(`${EMBEDDINGS_HOST}/embeddings`);
  expect(request.url).not.toContain(new URL(CHAT_HOST).hostname);
  expect(request.model).toBe(WIKI_MODEL);
  expect(request.authorization).toBe(`Bearer ${EMBED_KEY}`);
}

describe("the kg dimension embeds against the wiki's embeddings host (S2, S4)", () => {
  it("posts the wiki's model to the embeddings host, never to the chat host", async () => {
    const [host, embeddings, backend] = await loadModules();
    const descriptor = host.getEmbeddingProvider().describeEmbeddingBackend?.();

    // The descriptor path, asserted at the seam AND at the request: with the
    // shared key in the environment this case is the REAL deployment, and the
    // wiki-resolved backend is the one that must drive it.
    expect(descriptor?.baseURL).toBe(EMBEDDINGS_HOST);
    expect(descriptor?.apiKey).toBe(EMBED_KEY);
    expect(descriptor?.model).toBe(WIKI_MODEL);

    const run = backend.prepareEmbeddingBackend(descriptor, process.env);
    expect(run.problem).toBeNull();
    expect(run.backend).toEqual(descriptor);
    await backend.withEmbeddingBackend(run.backend, () => embeddings.embedTexts(["a"]));

    expectRequestOnEmbeddingsHost();
  });

  it("lands on the embeddings host through the env bridge too, with the shared key set", async () => {
    // The SECOND path, pinned so a broken bridge cannot hide behind a working
    // descriptor (or the reverse): no backend is installed here, so the request
    // is derived from the bridged KG environment alone.
    const [, embeddings, backend] = await loadModules();

    await backend.withEmbeddingBackend(undefined, () => embeddings.embedTexts(["a"]));

    expectRequestOnEmbeddingsHost();
  });

  it("keeps a kg-side backend in charge when the operator configured one (S3)", async () => {
    const kgEndpoint = "https://kg-own.invalid/v1";
    vi.stubEnv("EMBEDDING_PROVIDER", "gateway");
    vi.stubEnv("GATEWAY_URL", kgEndpoint);
    vi.stubEnv("GATEWAY_API_KEY", "test-key-not-real-kg");
    vi.stubEnv("EMBEDDING_MODEL", "kg-own-model");
    const [host, embeddings, backend] = await loadModules();

    const descriptor = host.getEmbeddingProvider().describeEmbeddingBackend?.();
    const run = backend.prepareEmbeddingBackend(descriptor, process.env);

    expect(run.backend).toBeUndefined();
    await embeddings.embedTexts(["a"]);

    const request = capturedEmbeddingRequest(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe(`${kgEndpoint}/embeddings`);
    expect(request.model).toBe("kg-own-model");
  });
});
