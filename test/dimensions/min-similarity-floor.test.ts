/**
 * @file test/dimensions/min-similarity-floor.test.ts
 * @description The per-store cosine floor: a level whose best hit falls below it
 * reports no signal, so the cascade can fall through instead of answering noise.
 *
 * ## The defect this pins
 *
 * Without a floor, ANY chunk above zero counts as a hit. `selectRelevantPages`
 * stops at the first non-empty level, so an out-of-domain question was answered
 * from pages that merely scored above zero and the index-selection fallback never
 * ran. Measured on a 28-page corpus: unrelated questions ("sourdough bread",
 * "capital of Portugal") returned 30 chunks and cut the cascade.
 *
 * ## Why the floor lives on the store
 *
 * Cosine scale belongs to the embedding space, not to the retriever. A dense model
 * separates on-domain from unrelated at ~0.55; the offline hashed bag-of-words
 * provider produces low cosines for BOTH, so a global constant either admits
 * everything or erases everything depending on the configured model. The store is
 * the only thing that knows which space produced its vectors.
 *
 * ## What each case protects
 *
 * - A store WITH a floor drops a level whose best hit is below it.
 * - A store WITHOUT one filters nothing: `undefined` must behave exactly like the
 *   pre-column code, because guessing a default silently returns zero pages for an
 *   uncalibrated provider.
 */
import { describe, it, expect, vi } from "vitest";
import { findRelevantPagesV3 } from "../../src/utils/embeddings-load.js";
import type { EmbeddingStoreV3, PageEmbeddingV3 } from "../../src/utils/embeddings-store.js";
import type { RegistryPageSource } from "../../src/utils/page-registry.js";

/**
 * Stub ONLY the embedding provider, returning the query vector `[1, 0]`.
 *
 * Every other field is stubbed explicitly for the reason `context-pack-embeddings`
 * documents: `isStaleConfiguration` asks `hasEmbeddingConfigurationOverride` and
 * `resolveEmbeddingEndpoint`, and a mock that omits them throws, is swallowed, and
 * makes every store read as stale for a reason unrelated to this suite.
 */
vi.mock("../../src/utils/embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/embedding-provider.js")>();
  return {
    ...actual,
    getEmbeddingProvider: () => ({
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    }),
    isEmbeddingProviderExplicit: () => false,
    hasEmbeddingConfigurationOverride: () => false,
    resolveEmbeddingEndpoint: () => "",
  };
});

/** Vectors are 2-D so a cosine can be chosen exactly instead of approximated. */
const DIMS = 2;

/** A unit vector rotated by `angle`, so cos(query, vector) === cos(angle). */
function at(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle)];
}

/** One page entry whose vector sits at `angle` from the query vector [1, 0]. */
function entry(pageId: string, angle: number): PageEmbeddingV3 {
  return {
    pageId,
    title: pageId,
    summary: "",
    embeddingTextHash: `h-${pageId}`,
    vector: at(angle),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A store with both pages, optionally carrying a similarity floor. */
function storeWith(minSimilarity?: number): EmbeddingStoreV3 {
  const base: EmbeddingStoreV3 = {
    version: 3,
    model: "test-model",
    dimensions: DIMS,
    // 0 rad is a perfect match (~1.0); 1.2 rad is ~0.36, below a 0.55 floor.
    entries: [entry("concepts/close", 0), entry("concepts/far", 1.2)],
  };
  return minSimilarity === undefined ? base : { ...base, minSimilarity };
}

/**
 * A registry source that reports every page live and hash-matching.
 *
 * Without this the freshness walk drops each candidate as stale and the suite would
 * measure nothing. Hashes are copied from the entries so the comparison succeeds.
 */
function liveRegistry(store: EmbeddingStoreV3): RegistryPageSource {
  const byId = new Map(store.entries.map((e) => [e.pageId, e]));
  return {
    liveIds: async () => new Set(byId.keys()),
    liveEntry: async (pageId: string) => {
      const found = byId.get(pageId);
      if (found === undefined) return null;
      return { embeddingTextHash: found.embeddingTextHash, chunkHashes: [] };
    },
    records: async () => [],
    recordPairs: async () => [],
    surfaceCandidates: async () =>
      store.entries.map((e) => ({ pageId: e.pageId, slug: e.pageId.split("/")[1] ?? "", title: e.title })),
  } as RegistryPageSource;
}

/** Retrieve page ids for `store` under the stubbed query vector, in rank order. */
async function rankedPageIds(store: EmbeddingStoreV3): Promise<string[]> {
  const { hits } = await findRelevantPagesV3(
    "", store, "search", "q", 15, undefined, liveRegistry(store),
  );
  return hits.map((hit) => hit.pageId);
}

describe("the per-store similarity floor", () => {
  it("keeps a level whose best hit clears the store's floor", async () => {
    // Ranking INSIDE a level is untouched: the far page is still returned even
    // though only the best hit was compared to the floor.
    expect(await rankedPageIds(storeWith(0.55))).toEqual(["concepts/close", "concepts/far"]);
  }, 30_000);

  it("reports no signal when even the best hit is below the floor", async () => {
    // The query vector is [1, 0] (stubbed above). Both entries sit at 1.2 rad and
    // 1.5 rad, i.e. cosines ~0.36 and ~0.07 -- every candidate is under a 0.55
    // floor, which is the out-of-domain case: this corpus cannot answer.
    const farOnly: EmbeddingStoreV3 = {
      version: 3,
      model: "test-model",
      dimensions: DIMS,
      minSimilarity: 0.55,
      entries: [entry("concepts/far-a", 1.2), entry("concepts/far-b", 1.5)],
    };
    const { hits } = await findRelevantPagesV3(
      "", farOnly, "search", "q", 15, undefined, liveRegistry(farOnly),
    );
    // No signal, so the cascade is free to fall through to index selection instead
    // of answering from two pages that merely scored above zero.
    expect(hits).toEqual([]);
  }, 30_000);

  it("filters NOTHING when the store declares no floor", async () => {
    // Uncalibrated must mean "no filter", never "guess a default".
    expect(await rankedPageIds(storeWith(undefined))).toEqual(["concepts/close", "concepts/far"]);
  }, 30_000);
});
