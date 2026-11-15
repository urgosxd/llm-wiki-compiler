/**
 * @file test/search-embedding-degrade.test.ts
 * @description The `search` sibling of the query embedding-degrade fix: with a
 * v3 store PRESENT, a failing embedding call (the keyless configuration — an
 * agent provider that cannot embed) degrades `pickSearchRefs` to the LLM/index
 * fallback — which needs no embedder — with an `embedding-degraded` warning,
 * instead of aborting the whole search.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useAlphaPageFixture, mockEmbeddingFailure } from "./fixtures/alpha-page.js";
import * as providerMod from "../packages/wiki/src/utils/provider.js";
import { pickSearchRefs } from "../packages/wiki/src/search/retrieval.js";
import {
  EmbeddingSpaceMismatchError,
  resolveEmbeddingFingerprint,
  resolveEmbeddingModel,
} from "../packages/wiki/src/utils/embeddings-store.js";
import type {
  ChunkRanking,
  EmbeddingStoreMeta,
} from "../packages/wiki/src/utils/embeddings-load.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

// The fallback's page-selection call (tools present) picks the seeded concept;
// it needs no embedder, which is the point.
vi.mock("../packages/wiki/src/utils/llm.js", () => ({
  callClaude: vi.fn(async () => JSON.stringify({ pages: ["concepts/alpha"], reasoning: "r" })),
}));

const seedRootWithPageStore = useAlphaPageFixture("search-embed-degrade", true);
/** A project with the seeded page but NO store: every case below supplies its own. */
const seedRoot = useAlphaPageFixture("search-embed-space-mismatch");

/** Width the store under test records. */
const DIMENSIONS = 768;

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "OLLAMA_HOST",
  "OLLAMA_EMBEDDINGS_HOST",
]);

afterEach(() => {
  restore();
});

/** One provider, one pinned model, and no endpoint override. */
function useActiveConfig(): void {
  setEnv({ LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDING_MODEL: "active-space-model" });
}

/** A header stamped by the ACTIVE configuration, so only the full store disagrees. */
function matchingMeta(): EmbeddingStoreMeta {
  return { model: resolveEmbeddingModel(), dimensions: DIMENSIONS, fingerprint: resolveEmbeddingFingerprint() };
}

/** A full store built in ANOTHER embedding configuration, at the store's own width. */
function mismatchedStore(): Record<string, unknown> {
  return {
    version: 3,
    model: resolveEmbeddingModel(),
    dimensions: DIMENSIONS,
    fingerprint: "b".repeat(64),
    entries: [],
    chunks: [],
  };
}

/** Stub the embedder so the query can be embedded; the refusal must precede ranking. */
function mockEmbeddingOk(): ReturnType<typeof vi.fn> {
  const vec = Array.from({ length: DIMENSIONS }, (_unused, index) => (index === 0 ? 1 : 0));
  const embed = vi.fn(async () => vec);
  const stub = { embed, embedBatch: vi.fn(async (texts: string[]) => texts.map(() => vec)) };
  vi.spyOn(providerMod, "getProvider").mockReturnValue(stub as unknown as ReturnType<typeof providerMod.getProvider>);
  return embed;
}

describe("search embedding failure degrades to the fallback", () => {
  it("returns fallback refs and carries the embedding-degraded warning", async () => {
    const root = await seedRootWithPageStore();
    const embed = mockEmbeddingFailure();

    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(pickSearchRefs(root, "what is alpha?")).rejects.toThrow("no embedding credentials");
    const { refs, warnings } = await pickSearchRefs(root, "what is alpha?", { embeddingFailure: "fallback" });
    // PRECONDITION pinned: the v3 store was loaded and the embed call was
    // actually reached — the degrade is witnessed, not vacuously absent.
    expect(embed, "the embedding path was never reached").toHaveBeenCalled();
    expect(refs.map((ref) => ref.pageId)).toEqual(["concepts/alpha"]);
    expect(warnings.map((w) => w.code)).toContain("embedding-degraded");
    expect(stdout).not.toHaveBeenCalled();
  });
});

/**
 * A wrong embedding space is NOT an embedder failure, so the opt-in recovery must not
 * reach it.
 *
 * `embeddingFailure: "fallback"` is documented as recovery from EMBEDDER failures:
 * requests that did not complete, are transient, and cost only precision to retry.
 * A mismatched store is the opposite -- a completed store of vectors from another
 * space, where degrading produces the confidently-wrong answer the whole feature
 * exists to remove. These cases come from both places the trap was set in the
 * pipeline: the page-level materialization (a full store read under a header that
 * agreed) and the source-backed ranking (a probe inside the ranking call itself).
 */
describe("a space mismatch is refused even when the caller opted into fallback", () => {
  it("refuses a mismatched full store reached through page-level materialization", async () => {
    useActiveConfig();
    const root = await seedRoot();
    const source = {
      read: async () => ({ kind: "parsed" as const, parsed: { version: 3 as const, store: mismatchedStore() } }),
      readMeta: async () => matchingMeta(),
      rankChunks: async (): Promise<ChunkRanking> => ({ kind: "ranked", hits: [] }),
    };
    const embed = mockEmbeddingOk();

    // The header AGREED, so the refusal can only come from materializing the store a
    // level below -- the catch this case exists to keep from swallowing it.
    await expect(
      pickSearchRefs(root, "what is alpha?", { embeddingFailure: "fallback", embeddingStoreSource: source }),
    ).rejects.toThrow(EmbeddingSpaceMismatchError);
    expect(embed, "the chunk level was never reached").toHaveBeenCalled();
  });

  it("refuses a ranking whose integrity probe reports another space", async () => {
    useActiveConfig();
    const root = await seedRoot();
    const source = {
      read: async () => ({ kind: "absent" as const }),
      readMeta: async () => matchingMeta(),
      rankChunks: async (): Promise<ChunkRanking> => {
        throw new EmbeddingSpaceMismatchError("the stored header names another embedding space");
      },
    };
    mockEmbeddingOk();

    // The ranking call itself refused. `embeddingFailure: "fallback"` covers a call
    // that could not complete, not one that completed against the wrong space.
    await expect(
      pickSearchRefs(root, "what is alpha?", { embeddingFailure: "fallback", embeddingStoreSource: source }),
    ).rejects.toThrow(EmbeddingSpaceMismatchError);
  });
});
