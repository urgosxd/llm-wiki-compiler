/**
 * @file test/dimensions/wiki-concept-embeddings.test.ts
 * @description The embedding port factory and its explicit degradation paths.
 *
 * Semantic grouping is optional, so every way it can be unavailable must be a
 * REPORTED value rather than a throw. These tests pin the reasons, because a
 * silent downgrade is the failure this module exists to prevent.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import {
  conceptEmbeddingPortOrUndefined,
  createConceptEmbeddingPort,
} from "../../src/dimensions/wiki/concept-embeddings.js";

/** Restore every stubbed environment variable after each test. */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createConceptEmbeddingPort", () => {
  it("reports an explicit opt-out as disabled", () => {
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "0");
    const setup = createConceptEmbeddingPort();
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.degradation.reason).toBe("embeddings-disabled");
  });

  it("reports an unusable provider name rather than throwing", () => {
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "not-a-provider");
    const setup = createConceptEmbeddingPort();
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.degradation.reason).toBe("embeddings-unconfigured");
    expect(setup.degradation.detail).toContain("not-a-provider");
  });
});

describe("conceptEmbeddingPortOrUndefined", () => {
  it("offers a port whose embed reports the configuration problem", async () => {
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "false");
    const port = conceptEmbeddingPortOrUndefined();
    expect(port).toBeDefined();
    const outcome = await port!.embed(["anything"]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.degradation.reason).toBe("embeddings-disabled");
  });
});
