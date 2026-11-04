/**
 * @file test/dimensions/kg-chat-backend.test.ts
 * @description Proves that an INJECTED chat backend supplies the kg dimension's
 * EXTRACTION endpoint, credential and model, that an explicitly configured
 * KG-side extraction variable still wins, and that every unusable credential is
 * refused by a message naming the variable to set.
 *
 * WHY EVERY CASE RELOADS THE MODULES. The vendored config is a lazy singleton
 * resolved once from the environment, so a case that states its own environment
 * needs a fresh module graph to be seen at all. `vi.resetModules()` plus a
 * dynamic import gives exactly that.
 *
 * No socket is opened: `fetch` is a stub answering one well-formed tool-call
 * payload. Every credential is obviously fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAME, capturedPost, toolCallPayload } from "./kg-request-capture.js";

/** The chat backend under test: what a wiki provider resolved for CHAT. */
const CHAT = {
  baseURL: "https://wiki-chat.invalid/api/v1",
  apiKey: "test-key-not-real-chat",
  model: "wiki-chat-model",
} as const;

/**
 * An environment in which nobody configured either extraction backend.
 *
 * The provider names are `undefined` rather than `""` on purpose: an explicitly
 * empty provider is an INVALID value the vendored schema rejects, while an
 * absent one takes its default.
 */
const CLEAN_ENV: Record<string, string | undefined> = {
  EXTRACTION_PROVIDER: undefined,
  EXTRACTION_MODEL: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
};

/** The model and endpoint a KG-side configuration names for itself. */
const KG_OWN_MODEL = "kg-own-chat-model";
const KG_ENDPOINT = "https://kg-own-chat.invalid/v1";
const KG_KEY = "test-key-not-real-kg";

/** The tool `callTool` is asked to force. */
const TOOL = { name: TOOL_NAME, description: "extraction", parameters: {} };

/** The refusal added for a descriptor that carries no credential. */
const NO_CREDENTIAL_PROBLEM =
  "The wiki dimension's chat backend resolved with no API key. " +
  "Set the wiki dimension's chat credential (OPENAI_API_KEY) or EXTRACTION_PROVIDER " +
  "with its own endpoint and credential to extract in the kg dimension.";

/** A fresh copy of the vendored modules, resolved under `env`. */
async function loadModules(env: Record<string, string | undefined> = CLEAN_ENV) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const [toolCall, endpoints, backend] = await Promise.all([
    import("../../packages/llmwiki-kg/ts/src/core/llm/tool-call.js"),
    import("../../packages/llmwiki-kg/ts/src/core/llm/endpoints.js"),
    import("../../packages/llmwiki-kg/ts/src/chat-backend.js"),
  ]);
  return { toolCall, endpoints, backend };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(toolCallPayload());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("an injected chat backend supplies the extraction request (S2, S4)", () => {
  it("posts to the descriptor's host with its credential and model", async () => {
    const { toolCall, backend } = await loadModules();

    await backend.withChatBackend(CHAT, () => toolCall.callTool("prompt", TOOL));

    const request = capturedPost(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe(`${CHAT.baseURL}/chat/completions`);
    expect(request.authorization).toBe(`Bearer ${CHAT.apiKey}`);
    expect(request.model).toBe(CHAT.model);
  });

  it("keeps an explicitly configured EXTRACTION_MODEL over the descriptor's", async () => {
    const { toolCall, backend } = await loadModules({ ...CLEAN_ENV, EXTRACTION_MODEL: KG_OWN_MODEL });

    await backend.withChatBackend(CHAT, () => toolCall.callTool("prompt", TOOL));

    expect(capturedPost(fetchSpy.mock.calls[0] as unknown[]).model).toBe(KG_OWN_MODEL);
  });

  it("leaves today's anthropic request untouched when nothing is injected", async () => {
    const { toolCall } = await loadModules({ ...CLEAN_ENV, ANTHROPIC_API_KEY: "test-key-not-real-anthropic" });

    await toolCall.callTool("prompt", TOOL);

    const request = capturedPost(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.apiKeyHeader).toBe("test-key-not-real-anthropic");
  });

  it("clears the backend after the scope closes, even when the work throws", async () => {
    const { backend } = await loadModules();

    await backend.withChatBackend(CHAT, () => Promise.resolve(undefined));
    expect(backend.injectedChatEndpoint()).toBeUndefined();

    await expect(
      backend.withChatBackend(CHAT, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(backend.injectedChatEndpoint()).toBeUndefined();
    expect(backend.injectedChatModel()).toBeUndefined();
  });
});

describe("an explicitly configured KG extraction backend still wins (S3)", () => {
  it("sends nothing through the descriptor once the KG side named a gateway", async () => {
    const { toolCall, backend } = await loadModules({
      ...CLEAN_ENV,
      EXTRACTION_PROVIDER: "gateway",
      GATEWAY_URL: KG_ENDPOINT,
      GATEWAY_API_KEY: KG_KEY,
      EXTRACTION_MODEL: KG_OWN_MODEL,
    });

    const run = backend.prepareChatBackend(CHAT, process.env);
    expect(run.backend).toBeUndefined();
    expect(run.problem).toBeNull();

    await backend.withChatBackend(run.backend, () => toolCall.callTool("prompt", TOOL));

    const request = capturedPost(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe(`${KG_ENDPOINT}/chat/completions`);
    expect(request.authorization).toBe(`Bearer ${KG_KEY}`);
    expect(request.model).toBe(KG_OWN_MODEL);
  });

  it("treats a named EXTRACTION_MODEL alone as the KG side configuring itself", async () => {
    const { backend } = await loadModules({ ...CLEAN_ENV, EXTRACTION_MODEL: KG_OWN_MODEL });

    expect(backend.configuresOwnChatBackend(process.env)).toBe(true);
    expect(backend.prepareChatBackend(CHAT, process.env).backend).toBeUndefined();
  });

  it("does not count a credential both namespaces read as a KG-side choice", async () => {
    const { backend } = await loadModules({ ...CLEAN_ENV, OPENAI_API_KEY: "test-key-not-real-shared" });

    expect(backend.configuresOwnChatBackend(process.env)).toBe(false);
    expect(backend.prepareChatBackend(CHAT, process.env).backend).toEqual(CHAT);
  });
});

describe("an unusable extraction credential is refused by name (S4)", () => {
  it("reports the variable each provider needs, and nothing when complete", async () => {
    const { backend } = await loadModules();

    expect(backend.findExtractionCredentialProblem({ EXTRACTION_PROVIDER: "anthropic" })).toBe(
      "EXTRACTION_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. " +
        "Set ANTHROPIC_API_KEY to extract in the kg dimension.",
    );
    expect(backend.findExtractionCredentialProblem({ EXTRACTION_PROVIDER: "openai" })).toBe(
      "EXTRACTION_PROVIDER=openai but OPENAI_API_KEY is not set. " +
        "Set OPENAI_API_KEY to extract in the kg dimension.",
    );
    expect(backend.findExtractionCredentialProblem({ EXTRACTION_PROVIDER: "gateway" })).toBe(
      "EXTRACTION_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set. " +
        "Set both to extract in the kg dimension.",
    );
    expect(
      backend.findExtractionCredentialProblem({
        EXTRACTION_PROVIDER: "openai",
        OPENAI_API_KEY: CHAT.apiKey,
      }),
    ).toBeNull();
  });

  it("refuses a descriptor that carries no credential, before any request", async () => {
    const { backend } = await loadModules();

    const run = backend.prepareChatBackend({ ...CHAT, apiKey: "" }, {});

    expect(run.backend).toBeUndefined();
    expect(run.problem).toBe(NO_CREDENTIAL_PROBLEM);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("installs a complete descriptor", async () => {
    const { backend } = await loadModules();

    expect(backend.prepareChatBackend(CHAT, {}).backend).toEqual(CHAT);
  });
});

describe("the injected model honours the environment it was given (S3)", () => {
  it("reads EXTRACTION_MODEL from that environment, not the process one", async () => {
    const { backend } = await loadModules({ ...CLEAN_ENV, EXTRACTION_MODEL: "process-model-not-real" });

    const model = await backend.withChatBackend(CHAT, () =>
      backend.injectedChatModel({ EXTRACTION_MODEL: "injected-model-not-real" }),
    );

    expect(model).toBe("injected-model-not-real");
  });

  it("falls back to the descriptor's model for a blank value", async () => {
    const { backend } = await loadModules({ ...CLEAN_ENV, EXTRACTION_MODEL: "process-model-not-real" });

    const model = await backend.withChatBackend(CHAT, () =>
      backend.injectedChatModel({ EXTRACTION_MODEL: "  " }),
    );

    expect(model).toBe(CHAT.model);
  });
});
