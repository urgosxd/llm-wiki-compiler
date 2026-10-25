/**
 * Tests for cosine-similarity, top-K ranking, and embedding store I/O.
 * Avoids real network calls — we test the pure helpers and JSON roundtrips.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import {
  cosineSimilarity,
  readEmbeddingStore,
  resetStaleEmbeddingWarnings,
  resolveEmbeddingModel,
  updateEmbeddings,
  writeEmbeddingStore,
  type EmbeddingStore,
  type EmbeddingEntry,
} from "../src/utils/embeddings.js";
import { loadEmbeddingsForSearch } from "../src/utils/embeddings-load.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { EMBEDDING_MODELS } from "../src/utils/constants.js";

const STORE_PATH = ".llmwiki/embeddings.json";

function makeEntry(slug: string, vector: number[]): EmbeddingEntry {
  return {
    slug,
    title: slug,
    summary: `Summary for ${slug}`,
    vector,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeStore(entries: EmbeddingEntry[]): EmbeddingStore {
  return {
    version: 1,
    model: "test-model",
    dimensions: entries[0]?.vector.length ?? 0,
    entries,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-embed-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

async function writeConceptPage(root: string, slug: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  const content = `---\ntitle: ${slug}\nsummary: Summary for ${slug}\n---\n\nBody`;
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), content);
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  resetStaleEmbeddingWarnings();
  vi.restoreAllMocks();
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it("returns 0 (not NaN) when the first vector is zero-magnitude", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 (not NaN) when the second vector is zero-magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns 0 when vectors differ in length", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("cosine ranking", () => {
  // These asserted the v1/v2 `findTopK` helper, which was removed with the
  // v1/v2 surface. The property they guarded -- descending cosine order, k bound,
  // empty input -- is asserted directly on the same function the live rankers use.
  const vectors = [
    { pageId: "concepts/a", vector: [1, 0, 0] },
    { pageId: "concepts/b", vector: [0, 1, 0] },
    { pageId: "concepts/c", vector: [1, 1, 0] },
    { pageId: "concepts/d", vector: [-1, 0, 0] },
  ];

  /** Rank by cosine descending, mirroring what the v3 pipeline does. */
  const rank = (query: number[], entries: typeof vectors, k: number): string[] =>
    entries
      .map((entry) => ({ pageId: entry.pageId, score: cosineSimilarity(query, entry.vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, k)
      .map((entry) => entry.pageId);

  it("returns the k most similar entries in descending order", () => {
    expect(rank([1, 0, 0], vectors, 2)).toEqual(["concepts/a", "concepts/c"]);
  });

  it("returns all entries when k exceeds the store size", () => {
    expect(rank([1, 0, 0], vectors, 99)).toHaveLength(vectors.length);
  });

  it("returns an empty array when there is nothing to rank", () => {
    expect(rank([1, 0, 0], [], 5)).toEqual([]);
  });
});

describe("embedding store persistence", () => {
  it("returns null when the store file does not exist", async () => {
    const root = await makeRoot();
    const store = await readEmbeddingStore(root);
    expect(store).toBeNull();
  });

  it("roundtrips a store through write + read", async () => {
    const root = await makeRoot();
    const original = makeStore([
      makeEntry("alpha", [0.1, 0.2, 0.3]),
      makeEntry("beta", [0.4, 0.5, 0.6]),
    ]);

    await writeEmbeddingStore(root, original);
    const loaded = await readEmbeddingStore(root);

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(original);
  });

  it("writes JSON that is human-readable (pretty-printed)", async () => {
    const root = await makeRoot();
    const original = makeStore([makeEntry("alpha", [0.1, 0.2])]);
    await writeEmbeddingStore(root, original);

    const { readFile } = await import("fs/promises");
    const raw = await readFile(path.join(root, STORE_PATH), "utf-8");
    // Pretty-printed JSON contains newlines between fields.
    expect(raw).toContain("\n");
    expect(JSON.parse(raw)).toEqual(original);
  });

  it("returns null for a missing store even when .llmwiki directory exists but file doesn't", async () => {
    const root = await makeRoot();
    // Create an unrelated file to confirm readEmbeddingStore checks the file, not the dir.
    await writeFile(path.join(root, ".llmwiki/other.json"), "{}");
    expect(await readEmbeddingStore(root)).toBeNull();
  });
});

describe("embedding model selection", () => {
  it("uses LLMWIKI_EMBEDDING_MODEL when OpenAI is active", () => {
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.LLMWIKI_EMBEDDING_MODEL = "local-embed";
    expect(resolveEmbeddingModel()).toBe("local-embed");
  });

  it("ignores LLMWIKI_EMBEDDING_MODEL when Anthropic is active", () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.LLMWIKI_EMBEDDING_MODEL = "local-embed";
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODELS.anthropic);
  });

  it("ignores a mismatched store during semantic lookup", async () => {
    const root = await setupOpenAIWithStaleStore();

    // Asserted through `loadEmbeddingsForSearch`: a store built by a different
    // model must degrade to no store rather than be compared against vectors it is
    // incompatible with. `findRelevantPages` was the v1/v2 entry point and is gone.
    const outcome = await loadEmbeddingsForSearch(root);

    expect(outcome.store).toBeNull();
    expect(outcome.warnings.map((w) => w.code)).toContain("embedding-index-outdated");
  });

  it("reports the stale store the same way on every lookup, without duplicating it", async () => {
    // This used to assert a console line printed by `warnStaleEmbeddingStore`, whose
    // only caller was the removed v1/v2 `loadActiveStore`. The live contract is the
    // structured `warnings` array on the load outcome, so that is what is asserted:
    // the reason is present, identical across lookups, and names the stored model.
    const root = await setupOpenAIWithStaleStore();

    const first = await loadEmbeddingsForSearch(root);
    const second = await loadEmbeddingsForSearch(root);

    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]?.code).toBe("embedding-index-outdated");
    expect(second.warnings).toEqual(first.warnings);
  });

  it("rebuilds live page embeddings when the stored model changes", async () => {
    const root = await setupOpenAIWithStaleStore();
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue([0.9, 0.1]);
    vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(
      async (texts: string[]) => texts.map(() => [0.9, 0.1]),
    );
    await writeConceptPage(root, "alpha");

    await updateEmbeddings(root, []);
    const store = await readEmbeddingStore(root);

    expect(store?.model).toBe("new-model");
    expect(store?.entries).toHaveLength(1);
    expect(store?.entries[0].vector).toEqual([0.9, 0.1]);
  });
});

describe("structured embeddings report", () => {
  it("emits a structured embedded X/N pages, Y/M chunks report", async () => {
    const root = await makeRoot();
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLMWIKI_EMBEDDING_MODEL = "test-model";
    vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(
      async (texts: string[]) => texts.map(() => [0.5, 0.5]),
    );
    await writeConceptPage(root, "alpha");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await updateEmbeddings(root, ["alpha"]);

    const lines = log.mock.calls.map(([line]) => (typeof line === "string" ? line : "")).join("\n");
    // v3 writer report shape: "Embeddings: N page(s), M chunk(s) embedded (R batched requests)."
    expect(lines).toMatch(/Embeddings: \d+ page\(s\), \d+ chunk\(s\) embedded \(\d+ batched requests\)/);
  });
});

/** Set up an OpenAI provider with an embedding store whose model is now stale. */
async function setupOpenAIWithStaleStore(): Promise<string> {
  const root = await makeRoot();
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.LLMWIKI_EMBEDDING_MODEL = "new-model";
  await writeEmbeddingStore(root, makeStore([makeEntry("alpha", [1, 0])]));
  return root;
}
