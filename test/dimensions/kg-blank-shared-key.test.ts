/**
 * @file test/dimensions/kg-blank-shared-key.test.ts
 * @description A present-but-EMPTY `OPENAI_API_KEY` must count as unset when the
 * provider is CONSTRUCTED, so the kg dimension reports its own named message
 * instead of the OpenAI SDK's.
 *
 * `OPENAI_API_KEY=` in a `.env` is a normal way to leave a variable declared and
 * empty. Passing that empty string to the SDK made the constructor throw
 * ("Missing credentials. Please pass an `apiKey`…"), and that sentence reached
 * the operator as if it were this project's own configuration message — naming
 * neither the variable to set nor the shared credential to reuse.
 *
 * The wiring under test is the real host one: the provider factory builds the
 * provider and reports the backend it resolved. No socket is opened, no database
 * is touched, and no credential is real.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** The message the kg dimension owns for a backend that resolved no credential. */
const NO_CREDENTIAL_MESSAGE =
  "The wiki dimension's embedding backend resolved with no API key. " +
  "Set the wiki dimension's embedding credential (OPENAI_EMBEDDINGS_API_KEY) " +
  "or GATEWAY_API_KEY to reuse that backend in the kg dimension.";

/**
 * The deployment: the wiki side is configured, its shared embedding key is
 * declared but empty, and the kg side names nothing.
 */
const BLANK_SHARED_KEY_ENV: Record<string, string> = {
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_EMBEDDING_PROVIDER: "",
  LLMWIKI_EMBEDDING_MODEL: "wiki-embed-768",
  OPENAI_API_KEY: "",
  OPENAI_EMBEDDINGS_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_EMBEDDINGS_BASE_URL: "",
  EMBEDDING_PROVIDER: "",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
  EMBEDDING_MODEL: "",
};

/**
 * A fresh module graph under this case's environment, so the vendored config and
 * the host factory both read it rather than whatever the runner holds.
 */
async function loadModules() {
  vi.resetModules();
  for (const [name, value] of Object.entries(BLANK_SHARED_KEY_ENV)) vi.stubEnv(name, value);
  return {
    host: await import("../../packages/wiki/src/utils/embedding-provider.js"),
    backend: await import("@repo/kg/embedding-backend"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("a blank shared credential is unset (S4, S5)", () => {
  it("builds the provider instead of letting the SDK refuse it", async () => {
    const { host } = await loadModules();

    expect(() => host.getEmbeddingProvider()).not.toThrow();
  });

  it("reports the kg dimension's own message, never the SDK's", async () => {
    const { host, backend } = await loadModules();

    const descriptor = host.getEmbeddingProvider().describeEmbeddingBackend?.();
    const run = backend.prepareEmbeddingBackend(descriptor, process.env);

    expect(run.problem).toBe(NO_CREDENTIAL_MESSAGE);
    expect(run.problem).not.toContain("Missing credentials");
  });

  it("keeps a real shared credential reaching the embeddings client", async () => {
    const { host, backend } = await loadModules();
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");

    const descriptor = host.getEmbeddingProvider().describeEmbeddingBackend?.();

    expect(descriptor?.apiKey).toBe("test-key-not-real");
    expect(backend.prepareEmbeddingBackend(descriptor, { LLMWIKI_EMBEDDING_MODEL: "m" }).backend)
      .toBeDefined();
  });
});
