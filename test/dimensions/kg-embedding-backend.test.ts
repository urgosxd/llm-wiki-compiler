/**
 * @file test/dimensions/kg-embedding-backend.test.ts
 * @description Proves that an INJECTED embedding backend replaces the vendored
 * core's env-derived endpoint, credential and model, and that the injection is
 * scoped to the call that received it.
 *
 * WHY EVERY CASE RELOADS THE MODULES. The vendored config is a lazy singleton
 * resolved once from the environment, so a case that states its own environment
 * needs a fresh module graph to be seen at all. `vi.resetModules()` plus a
 * dynamic import gives exactly that and keeps the cases independent of whatever
 * the worker's environment happens to hold.
 *
 * No socket is opened: `fetch` is a stub answering one well-formed embeddings
 * payload. Every credential is obviously fake, so a leak is unmistakable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchSpy } from "./kg-request-capture.js";
import { capturedEmbeddingRequest } from "./kg-embedding-capture.js";

/** The descriptor under test: a wiki-side backend, nothing the KG configured. */
const INJECTED = {
  baseURL: "https://wiki-embed.invalid/v1",
  apiKey: "test-key-not-real-wiki",
  model: "wiki-embed-768",
} as const;

/** A KG-side configuration that is complete on its own, so nothing is bridged. */
const KG_OWN_CONFIG = {
  EMBEDDING_PROVIDER: "gateway",
  GATEWAY_URL: "https://kg-own.invalid/v1",
  GATEWAY_API_KEY: "test-key-not-real-kg",
} as const;

/** The whole environment each reload starts from, so no case inherits another. */
const CLEAN_ENV: Record<string, string> = {
  EMBEDDING_PROVIDER: KG_OWN_CONFIG.EMBEDDING_PROVIDER,
  GATEWAY_URL: KG_OWN_CONFIG.GATEWAY_URL,
  GATEWAY_API_KEY: KG_OWN_CONFIG.GATEWAY_API_KEY,
  EMBEDDING_MODEL: "",
  OPENAI_API_KEY: "",
  LLMWIKI_EMBEDDING_PROVIDER: "",
  LLMWIKI_PROVIDER: "",
  LLMWIKI_EMBEDDING_MODEL: "",
};

/** The KG's own model choice, used by the cases that exercise precedence. */
const KG_OWN_MODEL = "kg-own-model";

/** The two messages this feature adds, with their exact text. */
const NO_CREDENTIAL_PROBLEM =
  "The wiki dimension's embedding backend resolved with no API key. " +
  "Set the wiki dimension's embedding credential (OPENAI_EMBEDDINGS_API_KEY) " +
  "or GATEWAY_API_KEY to reuse that backend in the kg dimension.";

/** One valid embeddings payload, so `embedTexts` reaches its return path. */
function embeddingsPayload(): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
    status: 200,
  });
}

/** A fresh copy of the vendored modules, resolved under `env`. */
async function loadModules(env: Record<string, string> = CLEAN_ENV) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const [embeddings, endpoints, backend] = await Promise.all([
    import("../../packages/llmwiki-kg/ts/src/core/llm/embeddings.js"),
    import("../../packages/llmwiki-kg/ts/src/core/llm/endpoints.js"),
    import("../../packages/llmwiki-kg/ts/src/embedding-backend.js"),
  ]);
  return { embeddings, endpoints, backend };
}


let fetchSpy: FetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(embeddingsPayload());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("an injected backend supplies the embedding request (S2, S4)", () => {
  it("posts to the descriptor's endpoint with its credential and model", async () => {
    const { embeddings, backend } = await loadModules();
    const { withEmbeddingBackend } = backend;

    await withEmbeddingBackend(INJECTED, () => embeddings.embedTexts(["a"]));

    const request = capturedEmbeddingRequest(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe(`${INJECTED.baseURL}/embeddings`);
    expect(request.authorization).toBe(`Bearer ${INJECTED.apiKey}`);
    expect(request.model).toBe(INJECTED.model);
  });

  it("keeps an explicitly configured EMBEDDING_MODEL over the descriptor's", async () => {
    const { embeddings, backend } = await loadModules({ ...CLEAN_ENV, EMBEDDING_MODEL: KG_OWN_MODEL });

    await backend.withEmbeddingBackend(INJECTED, () => embeddings.embedTexts(["a"]));

    expect(capturedEmbeddingRequest(fetchSpy.mock.calls[0] as unknown[]).model).toBe(KG_OWN_MODEL);
  });

  it("derives everything from the KG's own config when nothing is injected", async () => {
    const { embeddings, backend } = await loadModules({ ...CLEAN_ENV, EMBEDDING_MODEL: KG_OWN_MODEL });
    expect(backend.injectedEmbeddingEndpoint()).toBeUndefined();

    await embeddings.embedTexts(["a"]);

    const request = capturedEmbeddingRequest(fetchSpy.mock.calls[0] as unknown[]);
    expect(request.url).toBe(`${KG_OWN_CONFIG.GATEWAY_URL}/embeddings`);
    expect(request.authorization).toBe(`Bearer ${KG_OWN_CONFIG.GATEWAY_API_KEY}`);
    expect(request.model).toBe(KG_OWN_MODEL);
  });

  it("clears the backend after the scope closes, even when the work throws", async () => {
    const { backend, endpoints } = await loadModules();
    const derived = endpoints.embeddingEndpoint();

    await backend.withEmbeddingBackend(INJECTED, () => Promise.resolve(undefined));
    expect(backend.injectedEmbeddingEndpoint()).toBeUndefined();
    expect(endpoints.embeddingEndpoint()).toEqual(derived);

    await expect(
      backend.withEmbeddingBackend(INJECTED, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(backend.injectedEmbeddingEndpoint()).toBeUndefined();
  });
});

/**
 * The deployment this feature exists for: the wiki names the shared key and the
 * embedding model, the kg side names nothing at all.
 */
const SHARED_KEY_ONLY_ENV: Record<string, string> = {
  OPENAI_API_KEY: "test-key-not-real-shared",
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_EMBEDDING_MODEL: "wiki-embed-768",
  EMBEDDING_PROVIDER: "",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
  EMBEDDING_MODEL: "",
};

describe("the shared credential alone does not mean the kg side configured itself (S2)", () => {
  it("installs the descriptor when only the shared key is set", async () => {
    // Counting the SHARED key as a kg-side choice left the descriptor
    // uninstalled here, in every real deployment that shares a credential.
    const { backend } = await loadModules(SHARED_KEY_ONLY_ENV);

    const run = backend.prepareEmbeddingBackend(INJECTED, process.env);

    expect(run.problem).toBeNull();
    expect(run.backend).toEqual(INJECTED);
  });

  it("still keeps the env path when the kg side named its own provider", async () => {
    const { backend } = await loadModules({ ...SHARED_KEY_ONLY_ENV, EMBEDDING_PROVIDER: "gateway" });

    expect(backend.configuresOwnEmbeddingBackend(process.env)).toBe(true);
    expect(backend.prepareEmbeddingBackend(INJECTED, process.env).backend).toBeUndefined();
  });

  it("still keeps the env path when the kg side named its own gateway endpoint", async () => {
    const { backend } = await loadModules({ ...SHARED_KEY_ONLY_ENV, GATEWAY_URL: "https://kg-own.invalid/v1" });

    expect(backend.configuresOwnEmbeddingBackend(process.env)).toBe(true);
  });
});

describe("an injected environment is honoured, not the process one (S3)", () => {
  it("reads EMBEDDING_MODEL from the environment it was given", async () => {
    const { backend } = await loadModules({ ...CLEAN_ENV, EMBEDDING_MODEL: "process-model-not-real" });

    const model = await backend.withEmbeddingBackend(INJECTED, () =>
      backend.injectedEmbeddingModel({ EMBEDDING_MODEL: "injected-model-not-real" }),
    );

    expect(model).toBe("injected-model-not-real");
  });

  it("falls back to the descriptor's model for a blank injected value", async () => {
    const { backend } = await loadModules({ ...CLEAN_ENV, EMBEDDING_MODEL: "process-model-not-real" });

    const model = await backend.withEmbeddingBackend(INJECTED, () =>
      backend.injectedEmbeddingModel({ EMBEDDING_MODEL: "  " }),
    );

    expect(model).toBe(INJECTED.model);
  });
});

describe("the injected backend only fills what the KG side left blank (S3)", () => {
  it("leaves an explicitly configured KG backend in charge", async () => {
    const { backend } = await loadModules();

    const run = backend.prepareEmbeddingBackend(INJECTED, { ...CLEAN_ENV });

    expect(run.backend).toBeUndefined();
    expect(run.problem).toBeNull();
  });

  it("refuses a descriptor that carries no credential", async () => {
    const { backend } = await loadModules();
    const credentialless = { ...INJECTED, apiKey: "" };

    const run = backend.prepareEmbeddingBackend(credentialless, {});

    expect(run.backend).toBeUndefined();
    expect(run.problem).toBe(NO_CREDENTIAL_PROBLEM);
  });

  it("refuses a resolved model the operator did not choose", async () => {
    const { backend } = await loadModules();

    const run = backend.prepareEmbeddingBackend(INJECTED, {});

    expect(run.backend).toBeUndefined();
    expect(run.problem).toContain(INJECTED.model);
    expect(run.problem).toContain("768");
    expect(run.problem).toContain("LLMWIKI_EMBEDDING_MODEL");
  });

  it("installs the descriptor once the operator has chosen the model", async () => {
    const { backend } = await loadModules();

    const run = backend.prepareEmbeddingBackend(INJECTED, {
      LLMWIKI_EMBEDDING_MODEL: "operator-chosen-768",
    });

    expect(run.problem).toBeNull();
    expect(run.backend).toEqual(INJECTED);
  });
});
