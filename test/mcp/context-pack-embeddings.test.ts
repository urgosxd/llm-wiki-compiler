/**
 * @file test/mcp/context-pack-embeddings.test.ts
 * @description `get_context_pack` must search the Stack's vectors, not a disk index.
 *
 * ## The condition the old tests did not contain
 *
 * The pack had passing tests on disk fixtures, where the page files and the
 * `.llmwiki/embeddings.json` store are the same world. On a Stack they are not: the
 * pages and their vectors are rows, and there is no `wiki/` directory to enumerate.
 * There, an unwired embedding seam returns `chunks: []` with an
 * `embedding-index-outdated` warning — indistinguishable, to a caller, from "nothing
 * was relevant".
 *
 * ## The two seams, and why one alone is not enough
 *
 * Two independent halves have to be threaded or the search silently empties:
 *
 *   1. The embedding store (`withEmbeddingStoreSource`) says which vectors exist.
 *   2. The registry source (`withRegistrySource`) says which of their pages are LIVE.
 *
 * The chunk prefilter intersects the two. With only the store, every chunk is
 * discarded as stale because live ids were resolved from disk. With only the
 * registry, there is no store to search at all. The first test pins the working
 * composition and the second pins the store half specifically, by reproducing the
 * exact state the tool shipped in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import {
  buildContextPack,
  withEmbeddingStoreSource,
  withRegistrySource,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { databaseEmbeddingSink, splitPageId } from "../../src/utils/embeddings-database.js";
import { hashChunkText, splitIntoChunks } from "../../src/utils/retrieval.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3, PageEmbeddingV3 } from "../../src/utils/embeddings-store.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** Body of the row-backed page. Its chunk hash must match what the registry computes. */
const PAGE_BODY = "Graph traversal notes about architecture.";
const DIMENSIONS = 768;
/**
 * The store's declared model must equal the ACTIVE embedding configuration, or
 * `storeMatchesActiveEmbedding` rejects it as stale and the search degrades to a
 * warning. Pinned here rather than read from the ambient env so the suite answers the
 * same on a developer machine with credentials and in CI without them.
 */
const MODEL = "nomic-embed-text-v1.5";

/** Environment the store's configuration check expects, applied in `beforeEach`. */
const EMBEDDING_ENV = {
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_EMBEDDING_MODEL: MODEL,
} as const;

/**
 * A vector that matches the query on its first component.
 *
 * Deterministic on purpose: the subject is whether the store is searched at all, and
 * a provider call per case would make the suite depend on credentials to answer that.
 */
function vector(): number[] {
  const values = new Array<number>(DIMENSIONS).fill(0.01);
  values[0] = 1;
  return values;
}

/**
 * Offline provider stub.
 *
 * Only `getEmbeddingProvider` needs faking to keep the suite credential-free. The
 * second half is not optional: the store gate asks `hasEmbeddingConfigurationOverride`
 * and `resolveEmbeddingEndpoint` whether the ACTIVE configuration still matches the
 * store, and a mock that omits them throws inside `isStaleConfiguration`, which
 * swallows the throw into `true` — every store then reads as stale and the search
 * degrades for a reason that has nothing to do with what this suite measures. That
 * exact omission cost a debugging cycle, so both are stubbed explicitly.
 */
vi.mock("../../src/utils/embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/embedding-provider.js")>();
  return {
    ...actual,
    getEmbeddingProvider: () => ({
      embed: async () => vector(),
      embedBatch: async (texts: string[]) => texts.map(() => vector()),
    }),
    isEmbeddingProviderExplicit: () => false,
    // No endpoint override: the store is compared on its model, which the fixture pins.
    hasEmbeddingConfigurationOverride: () => false,
    resolveEmbeddingEndpoint: () => "",
    findEmbeddingProviderProblem: () => null,
  };
});

describe("get_context_pack embeddings on a Stack", () => {
  let stack: ProbeStack;
  let root: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(async () => {
    stack = await createProbeStack("context-pack-embeddings");
    // The seams read `AKS_STACK_ID` from the ambient environment, so the Stack has to
    // BE the environment for the duration of the case -- and be put back afterwards.
    saved = { ...process.env };
    Object.assign(process.env, stack.env(), EMBEDDING_ENV);
    // No wiki/ tree at all: pages and vectors exist only as rows.
    root = await scratchProjectRoot("context-pack-emb-");
  });

  afterEach(async () => {
    process.env = saved;
    await stack.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  /** Insert the page row plus a page vector and one chunk vector for it. */
  async function seedRowBackedPage(harness: ProbeStack["harness"]): Promise<void> {
    const split = splitPageId("concepts/row-backed");
    if (split === null) throw new Error("fixture used a malformed page id");
    await harness.db.execute(
      `insert into wiki.pages (stack_id, page_directory, slug, title, body) values ('${harness.stackId}', '${split.pageDirectory}', '${split.slug}', 'Row Backed', '${PAGE_BODY}')`,
    );
    const page: PageEmbeddingV3 = {
      pageId: "concepts/row-backed",
      title: "Row Backed",
      summary: "s",
      embeddingTextHash: "h1",
      vector: vector(),
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const chunk: ChunkEmbeddingV3 = {
      pageId: "concepts/row-backed",
      title: "Row Backed",
      chunkIndex: 0,
      // Must equal the hash the registry derives from the LIVE body, or the freshness
      // walk discards the chunk as stale and the search looks like it found nothing.
      contentHash: hashChunkText(splitIntoChunks(PAGE_BODY)[0] ?? ""),
      text: splitIntoChunks(PAGE_BODY)[0] ?? "",
      vector: vector(),
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const store: EmbeddingStoreV3 = { version: 3, model: MODEL, dimensions: DIMENSIONS, entries: [page], chunks: [chunk] };
    await databaseEmbeddingSink(harness.db, harness.stackId).write(store);
  }

  it("returns semantic chunks for a page that exists only as a row", async () => {
    if (!stack.harness.reachable) return;
    await seedRowBackedPage(stack.harness);

    const pack = await withRegistrySource(process.env, (registryPageSource) =>
      withEmbeddingStoreSource(process.env, (embeddingStoreSource) =>
        buildContextPack({
          root,
          prompt: "graph traversal",
          embeddingStoreSource,
          registryPageSource,
        }),
      ),
    );

    const chunks = pack.primary.flatMap((page) => page.chunks ?? []);
    // The rows are the point: asserting on `primary.length` alone would pass on the
    // disk path too, because the page list already came from the registry.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.text).toContain("Graph traversal");
    expect(pack.warnings.map((warning) => warning.code)).not.toContain("embedding-index-outdated");
  }, 60_000);

  it("yields no chunks when the store seam is omitted", async () => {
    if (!stack.harness.reachable) return;
    await seedRowBackedPage(stack.harness);

    const pack = await withRegistrySource(process.env, (registryPageSource) =>
      buildContextPack({ root, prompt: "graph traversal", registryPageSource }),
    );

    // Pins the store half specifically: this is the state the tool shipped in, where
    // 73 page vectors and 217 chunk vectors were present and none were reachable.
    expect(pack.primary.flatMap((page) => page.chunks ?? [])).toHaveLength(0);
  }, 60_000);
});
