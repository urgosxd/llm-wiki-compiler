/**
 * Regression tests for embedding-store and read-side vector integrity.
 * These cases protect against silent zero-score ranking and warm-store
 * corruption surviving across compiles.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import {
  readEmbeddingStore,
  updateEmbeddings,
  writeEmbeddingStore,
  type EmbeddingStoreV3,
} from "../src/utils/embeddings.js";
import { loadEmbeddingsForSearch } from "../src/utils/embeddings-load.js";
import { expectDegradedStore } from "./fixtures/embeddings-degrade.js";
import { EmbeddingIntegrityError } from "../src/utils/embeddings-batch.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import * as providerMod from "../src/utils/provider.js";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-embed-validation-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

async function writeConcept(root: string, slug: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), `---\ntitle: ${slug}\nsummary: Sum\n---\n\nBody`);
}

async function writeRawStore(root: string, store: EmbeddingStoreV3): Promise<void> {
  await writeFile(path.join(root, ".llmwiki/embeddings.json"), JSON.stringify(store, null, 2));
}

function pageStore(vector: number[], dimensions = 2): EmbeddingStoreV3 {
  return {
    version: 3,
    model: "test-embed",
    dimensions,
    entries: [{
      pageId: "concepts/alpha",
      title: "Alpha",
      summary: "Sum",
      embeddingTextHash: "hash-alpha",
      vector,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    chunks: [],
  };
}

function setOpenAIEnv(): void {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
}

function stubEmbeddingVectors(vector: number[]): void {
  vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue(vector);
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async (texts: string[]) => (
    texts.map(() => vector)
  ));
}

function setupOpenAI(vector: number[]): void {
  setOpenAIEnv();
  stubEmbeddingVectors(vector);
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

describe("read-side embedding validation", () => {
  // These assert on `loadEmbeddingsForSearch`, which is the function production
  // actually calls. They used to go through `findRelevantPages`, a v1/v2 helper
  // keyed by bare `slug` that had no production caller and has been removed. The
  // gate itself is unchanged: a store whose vectors cannot be trusted must degrade
  // retrieval rather than rank poisoned data.
  it("degrades instead of ranking a store whose vectors fail integrity validation", async () => {
    const root = await makeRoot();
    setupOpenAI([1, 0]);
    await writeRawStore(root, pageStore([])); // empty vector: fails the gate

    await expectDegradedStore(root, "embedding-store-unavailable");
  });

  it("degrades instead of ranking a store built by a different embedding model", async () => {
    const root = await makeRoot();
    setupOpenAI([1, 0]);
    const stale = pageStore([1, 0]);
    stale.model = "some-other-model";
    await writeRawStore(root, stale);

    await expectDegradedStore(root, "embedding-index-outdated");
  });

  it("loads a healthy v3 store without warnings", async () => {
    const root = await makeRoot();
    setupOpenAI([1, 0]);
    await writeEmbeddingStore(root, pageStore([1, 0]));

    const outcome = await loadEmbeddingsForSearch(root);

    expect(outcome.store?.entries).toHaveLength(1);
    expect(outcome.warnings).toEqual([]);
  });
});

describe("updateEmbeddings corrupted-store recovery", () => {
  it("rebuilds an invalid same-model store instead of carrying bad vectors forward", async () => {
    const root = await makeRoot();
    setupOpenAI([0.9, 0.1]);
    await writeConcept(root, "alpha");
    await writeRawStore(root, pageStore([]));

    await updateEmbeddings(root, []);
    const rebuilt = await readEmbeddingStore(root);

    expect(rebuilt?.entries[0].vector).toEqual([0.9, 0.1]);
    expect(rebuilt?.dimensions).toBe(2);
  });
});
