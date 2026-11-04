/**
 * @file test/dimensions/kg-chat-host-separation.test.ts
 * @description The regression test for CROSSED WIRES: the chat backend a wiki
 * provider resolved must drive the kg dimension's EXTRACTION request, the
 * embedding backend must drive its EMBEDDINGS request, and neither may ever
 * serve the other side.
 *
 * WHY TWO HOSTS. With the deployment this feature exists for, the chat host and
 * the embeddings host are different services (`openrouter.ai` for chat,
 * `api.synthetic.new` for embeddings). One shared host hides the whole class of
 * bug: a descriptor that reports the wrong client still produces a well-formed
 * request, and only the response reveals it. Two distinct hosts, credentials and
 * models make the wiring observable in the request itself — in both directions.
 *
 * The wiring under test is the real one: the host provider factory builds the
 * provider, `describeChatBackend`/`describeEmbeddingBackend` report what it
 * resolved, and the vendored request paths are what post. `fetch` is the only
 * stub, so no socket is opened; every credential is obviously fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOOL_NAME,
  capturedPost,
  embeddingsPayload,
  toolCallPayload,
  type CapturedRequest,
} from "./kg-request-capture.js";

/** The chat host: the only correct destination for an extraction request. */
const CHAT_HOST = "https://chat.invalid/api/v1";
/** The embeddings host: the only correct destination for an embeddings request. */
const EMBEDDINGS_HOST = "https://embed.invalid/openai/v1";
/** One model per side, so a crossed model is as visible as a crossed host. */
const CHAT_MODEL = "vendor/chat-model";
const EMBEDDING_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
/** One fake credential per side, so a swap shows up in the header too. */
const CHAT_KEY = "test-key-not-real-chat";
const EMBEDDING_KEY = "test-key-not-real-embed";

/** The deployment the descriptor has to serve: wiki configured, kg unresolved. */
/**
 * The deployment the descriptor has to serve: wiki configured, kg unresolved.
 *
 * The two KG provider names are `undefined` rather than `""`: an explicitly
 * empty provider is an INVALID value the vendored schema rejects, while an
 * absent one is the deployment this test is about.
 */
const WIKI_ONLY_ENV: Record<string, string | undefined> = {
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_MODEL: CHAT_MODEL,
  LLMWIKI_EMBEDDING_MODEL: EMBEDDING_MODEL,
  OPENAI_BASE_URL: CHAT_HOST,
  OPENAI_EMBEDDINGS_BASE_URL: EMBEDDINGS_HOST,
  OPENAI_API_KEY: CHAT_KEY,
  OPENAI_EMBEDDINGS_API_KEY: EMBEDDING_KEY,
  EXTRACTION_PROVIDER: undefined,
  EXTRACTION_MODEL: "",
  ANTHROPIC_API_KEY: "",
  EMBEDDING_PROVIDER: undefined,
  EMBEDDING_MODEL: "",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
};

/** The tool `callTool` is asked to force. */
const TOOL = { name: TOOL_NAME, description: "extraction", parameters: {} };

/** A fresh module graph, so the vendored config sees this case's environment. */
function loadModules() {
  vi.resetModules();
  return Promise.all([
    import("../../src/utils/provider.js"),
    import("../../src/utils/embedding-provider.js"),
    import("../../packages/llmwiki-kg/ts/src/core/llm/embeddings.js"),
    import("../../packages/llmwiki-kg/ts/src/core/llm/tool-call.js"),
    import("../../packages/llmwiki-kg/ts/src/embedding-backend.js"),
    import("../../packages/llmwiki-kg/ts/src/chat-backend.js"),
  ]);
}

/**
 * Assert the request just captured went to the wiki's EMBEDDINGS host.
 *
 * Shared by the descriptor case and the crossed-wire case: they pin two
 * different wirings to the SAME destination, so one copy of the expectation
 * keeps them from drifting into asserting different things.
 *
 * @param request - The decoded request under test.
 */
function expectEmbeddingsHost(request: CapturedRequest): void {
  expect(request.url).toBe(`${EMBEDDINGS_HOST}/embeddings`);
  expect(request.model).toBe(EMBEDDING_MODEL);
  expect(request.authorization).toBe(`Bearer ${EMBEDDING_KEY}`);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

/**
 * Answer each POST with the payload its path implies.
 *
 * A single shared stub, because one case makes one request: answering both
 * shapes keeps every case written the same way.
 */
function answerByPath(url: string): Response {
  return url.includes("/embeddings") ? embeddingsPayload() : toolCallPayload();
}

beforeEach(() => {
  for (const [name, value] of Object.entries(WIKI_ONLY_ENV)) vi.stubEnv(name, value);
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input) => Promise.resolve(answerByPath(String(input))));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the kg dimension extracts against the wiki's chat host (S2, S4)", () => {
  it("reports the CHAT client — never the embeddings one", async () => {
    const [host] = await loadModules();

    const descriptor = host.getProvider().describeChatBackend?.();

    expect(descriptor?.baseURL).toBe(CHAT_HOST);
    expect(descriptor?.apiKey).toBe(CHAT_KEY);
    expect(descriptor?.model).toBe(CHAT_MODEL);
  });

  it("posts the extraction request to the chat host, never to the embeddings host", async () => {
    const [host, , , toolCall, , chatBackend] = await loadModules();
    const descriptor = host.getProvider().describeChatBackend?.();

    const run = chatBackend.prepareChatBackend(descriptor, process.env);
    expect(run.problem).toBeNull();
    await chatBackend.withChatBackend(run.backend, () => toolCall.callTool("prompt", TOOL));

    const request = capturedPost(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe(`${CHAT_HOST}/chat/completions`);
    expect(request.url).not.toContain(new URL(EMBEDDINGS_HOST).hostname);
    expect(request.model).toBe(CHAT_MODEL);
    expect(request.authorization).toBe(`Bearer ${CHAT_KEY}`);
  });
});

describe("the kg dimension embeds against the wiki's embeddings host (S2, S4)", () => {
  it("reports the EMBEDDINGS client — never the chat one", async () => {
    const [, embeddingHost] = await loadModules();

    const descriptor = embeddingHost.getEmbeddingProvider().describeEmbeddingBackend?.();

    expect(descriptor?.baseURL).toBe(EMBEDDINGS_HOST);
    expect(descriptor?.apiKey).toBe(EMBEDDING_KEY);
    expect(descriptor?.model).toBe(EMBEDDING_MODEL);
  });

  it("posts the embeddings request to the embeddings host, never to the chat host", async () => {
    const [, embeddingHost, embeddings, , embeddingBackend] = await loadModules();
    const descriptor = embeddingHost.getEmbeddingProvider().describeEmbeddingBackend?.();

    const run = embeddingBackend.prepareEmbeddingBackend(descriptor, process.env);
    expect(run.problem).toBeNull();
    await embeddingBackend.withEmbeddingBackend(run.backend, () => embeddings.embedTexts(["a"]));

    const request = capturedPost(fetchSpy.mock.calls[0] as unknown[]);
    expectEmbeddingsHost(request);
    expect(request.url).not.toContain(new URL(CHAT_HOST).hostname);
  });
});

describe("neither descriptor may serve the other side (S2)", () => {
  it("leaves an embeddings request on the embeddings host while a chat backend is installed", async () => {
    const [host, , embeddings, , , chatBackend] = await loadModules();
    const chatDescriptor = host.getProvider().describeChatBackend?.();

    await chatBackend.withChatBackend(chatDescriptor, () => embeddings.embedTexts(["a"]));

    expectEmbeddingsHost(capturedPost(fetchSpy.mock.calls[0] as unknown[]));
  });

  it("never sends an extraction request to the embeddings host while an embedding backend is installed", async () => {
    const [, embeddingHost, , toolCall, embeddingBackend] = await loadModules();
    const embeddingDescriptor = embeddingHost.getEmbeddingProvider().describeEmbeddingBackend?.();

    await embeddingBackend.withEmbeddingBackend(embeddingDescriptor, () =>
      toolCall.callTool("prompt", TOOL),
    );

    const request = capturedPost(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).not.toContain(new URL(EMBEDDINGS_HOST).hostname);
    expect(request.authorization).not.toBe(`Bearer ${EMBEDDING_KEY}`);
  });
});
