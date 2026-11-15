/**
 * @file test/embedding-space-mismatch.test.ts
 * @description A store recorded in one embedding space must be REFUSED, not
 * silently degraded, when the active configuration produces another one.
 *
 * ## The failure this pins (S1/S2)
 *
 * A model id that is not the one the store was built with is still a perfectly
 * valid request: it returns `200` and a vector of the same width drawn from a
 * different space. Cosine then compares two spaces, and every candidate is
 * either scored against noise or skipped entirely — so retrieval used to return
 * an EMPTY answer with a warning nobody reads (`embedding-index-outdated`). An
 * embedding produced in a different space answers confidently and wrongly; a
 * `200`, and equally an empty result, is not a pass.
 *
 * ## What each case asserts, and why through `pickSearchRefs`
 *
 * The refusal is observed at the retrieval entry point (`pickSearchRefs`, which
 * awaits the loader with no `catch` of its own), never on a private helper's
 * boolean: the named error, both sides in its message, and the absence of any
 * scored result. S5 is the other half — an ABSENT store is not a disagreement,
 * so first-run deployments must keep degrading exactly as before (S6 pins the
 * matching case byte-identical).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as providerMod from "../packages/wiki/src/utils/provider.js";
import { pickSearchRefs } from "../packages/wiki/src/search/retrieval.js";
import {
  resolveEmbeddingFingerprint,
  resolveEmbeddingModel,
  type EmbeddingStoreV3,
} from "../packages/wiki/src/utils/embeddings-store.js";
import {
  loadEmbeddingsForSearch,
  loadMetaForSearch,
  type ChunkRanking,
  type RankScope,
} from "../packages/wiki/src/utils/embeddings-load.js";
import { rankChunksInSql } from "../packages/wiki/src/utils/embeddings-rank-sql.js";
import { hashChunkText } from "../packages/wiki/src/utils/retrieval.js";
import { buildEmbeddingText } from "../packages/wiki/src/utils/embeddings-pages.js";
import { useAlphaPageFixture } from "./fixtures/alpha-page.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";
import { expectSpaceRefusalNamesBothSides } from "./fixtures/embedding-space-refusal.js";

// The LLM fallback is never the branch under test, but a DEGRADED load would fall
// through to it — and a real provider call would make the red run fail for the
// wrong reason. Stubbed so the only thing that can change the outcome is the gate.
vi.mock("../packages/wiki/src/utils/llm.js", () => ({
  callClaude: vi.fn(async () => JSON.stringify({ pages: [], reasoning: "r" })),
}));

/** The model the ACTIVE configuration resolves to in every case below. */
const ACTIVE_MODEL = "active-space-model";
/** The model the stored vectors were actually produced with (L1's real-world case). */
const STORED_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
/** Width the stored vectors really have. */
const STORED_DIMENSIONS = 768;

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "OPENAI_BASE_URL",
  "OLLAMA_EMBEDDINGS_HOST",
  "OLLAMA_HOST",
]);

const seedRoot = useAlphaPageFixture("space-mismatch");

afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

/** One provider, one pinned model, and (by default) no endpoint override. */
function useActiveConfig(extra: Record<string, string | undefined> = {}): void {
  setEnv({ LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDING_MODEL: ACTIVE_MODEL, ...extra });
}

/** A unit vector of the store's own width, so only the space check can refuse it. */
function wideVector(): number[] {
  return Array.from({ length: STORED_DIMENSIONS }, (_unused, index) => (index === 0 ? 1 : 0));
}

/** The one live page's embedding hash, computed the way the writer computes it. */
function liveEmbHash(): string {
  return hashChunkText(buildEmbeddingText({ title: "Alpha", summary: "a" }));
}

/** A v3 store for the seeded page, with `overrides` naming the side under test. */
function storeOf(overrides: Partial<EmbeddingStoreV3> = {}): EmbeddingStoreV3 {
  return {
    version: 3,
    model: resolveEmbeddingModel(),
    dimensions: STORED_DIMENSIONS,
    entries: [{
      pageId: "concepts/alpha",
      title: "Alpha",
      summary: "a",
      embeddingTextHash: liveEmbHash(),
      vector: wideVector(),
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    chunks: [],
    ...overrides,
  };
}

/** Persist `store` where the writer keeps it, beside the pages it covers. */
async function writeStore(root: string, store: EmbeddingStoreV3): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "embeddings.json"), JSON.stringify(store, null, 2));
}

/** Seed one live page plus, when `store` is given, the persisted index beside it. */
async function seedProject(store?: EmbeddingStoreV3): Promise<string> {
  const root = await seedRoot();
  if (store !== undefined) await writeStore(root, store);
  return root;
}

/** Stub the embedder with `vec`; the spy proves whether any candidate was scored. */
function mockEmbedding(vec: number[]): ReturnType<typeof vi.fn> {
  const embed = vi.fn(async () => vec);
  const stub = { embed, embedBatch: vi.fn(async (texts: string[]) => texts.map(() => vec)) };
  vi.spyOn(providerMod, "getProvider").mockReturnValue(stub as unknown as ReturnType<typeof providerMod.getProvider>);
  return embed;
}

/** The error `call` produced, or null when it produced a value instead. */
async function errorFrom(call: Promise<unknown>): Promise<Error | null> {
  const settled = await call.then((value) => value, (error: unknown) => error);
  return settled instanceof Error ? settled : null;
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
/** A Stack id; the SQL path never validates it, it only binds it. */
const STACK_ID = "00000000-0000-4000-8000-000000000001";

/** The scope every SQL case passes: no narrowing, nothing excluded. */
const OPEN_SCOPE: RankScope = { excludedNamespaces: [], surface: "search" };

/**
 * The `wiki.embedding_store_meta` row the SQL integrity probe reads.
 *
 * Defaults describe a store stamped by the ACTIVE configuration; `overrides`
 * moves one side of the comparison at a time.
 *
 * @param overrides - Columns to replace.
 * @returns One row in the shape the probe selects.
 */
function integrityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimensions: STORED_DIMENSIONS,
    model: resolveEmbeddingModel(),
    fingerprint: resolveEmbeddingFingerprint(),
    total: 1,
    bad_dims: 0,
    ...overrides,
  };
}

/**
 * A handle in the shape `rankChunksInSql` takes, answering each statement from a script
 * instead of a server.
 *
 * Typed from the ranking entry point's own parameter rather than from the foundation
 * package: naming `@repo/foundation` here would add a package edge this file only ever
 * reaches through a type, which the package-selection guard rightly reports.
 *
 * Statement order is fixed and named below, so a case asserts WHICH statements ran
 * (`statements()`) rather than what SQL text was built. The tenant bind answers
 * first and is not part of the caller's script.
 *
 * @param afterBind - Rows for the integrity probe, then for the ranking query.
 * @returns The handle plus a counter of statements that actually executed.
 */
function scriptedDb(afterBind: readonly (readonly Record<string, unknown>[])[]): {
  handle: Parameters<typeof rankChunksInSql>[0];
  statements: () => number;
} {
  const script = [[], ...afterBind];
  let executed = 0;
  const tx = {
    execute: async () => {
      const rows = script[executed] ?? [];
      executed += 1;
      return rows;
    },
    transaction: (): Promise<never> => Promise.reject(new Error("no nested transaction in this script")),
  };
  const handle = {
    execute: tx.execute,
    transaction: async (run: (inner: unknown) => Promise<unknown>) => run(tx),
  };
  return { handle: handle as never, statements: () => executed };
}

describe("S1/S2 — a store from another embedding space is an error, never an empty answer", () => {
  it("refuses to answer when the store's recorded model is not the active one", async () => {
    useActiveConfig();
    const root = await seedProject(storeOf({ model: STORED_MODEL }));
    const embed = mockEmbedding(wideVector());

    const refusal = await errorFrom(pickSearchRefs(root, "what is alpha?"));

    // The named error, not an empty result.
    expect(refusal).not.toBeNull();
    expect(refusal?.name).toBe("EmbeddingSpaceMismatchError");
    // S4: both sides are named, so an operator can tell which one to change.
    expectSpaceRefusalNamesBothSides(refusal, { model: STORED_MODEL, dimensions: STORED_DIMENSIONS }, ACTIVE_MODEL);
    // S2: nothing was scored, so no result can be returned for the wrong space.
    expect(embed).not.toHaveBeenCalled();
  });

  it("refuses a store stamped by another configuration even when the model name matches", async () => {
    useActiveConfig();
    const root = await seedProject(storeOf({ fingerprint: "b".repeat(64) }));
    mockEmbedding(wideVector());

    const refusal = await errorFrom(pickSearchRefs(root, "what is alpha?"));

    expect(refusal?.name).toBe("EmbeddingSpaceMismatchError");
    expect(refusal?.message).toContain(`"${ACTIVE_MODEL}"`);
    expect(refusal?.message).toContain(`${STORED_DIMENSIONS} dimensions`);
  });

  // A fingerprint-only mismatch needs its own sentence: the model ids AGREE, so the
  // only fact that is printed twice would be the one that is not in dispute.
  it("describes a fingerprint-only mismatch as a configuration change, not two model ids", async () => {
    useActiveConfig();
    const storedFingerprint = "b".repeat(64);
    const root = await seedProject(storeOf({ fingerprint: storedFingerprint }));
    mockEmbedding(wideVector());

    const message = (await errorFrom(pickSearchRefs(root, "what is alpha?")))?.message ?? "";

    // Both sides name the SAME model, so printing that id twice states the one
    // thing that is not in dispute and hides the one thing that is.
    expect(countOccurrences(message, `"${ACTIVE_MODEL}"`)).toBe(1);
    // The fingerprint is an opaque SHA-256 digest, so a short form of each side
    // can be shown: that is the only thing that actually differs.
    expect(message).toContain(storedFingerprint.slice(0, 12));
    expect(message).toContain(resolveEmbeddingFingerprint().slice(0, 12));
    // It reads as what it is — a different embedding CONFIGURATION — and so
    // cannot be mistaken for the model-differs refusal.
    expect(message.toLowerCase()).toContain("configuration");
    const modelDiffersRoot = await seedProject(storeOf({ model: STORED_MODEL }));
    const modelDiffers = (await errorFrom(pickSearchRefs(modelDiffersRoot, "what is alpha?")))?.message;
    expect(message).not.toEqual(modelDiffers);
    // Nothing hosted or credentialed may appear in a diagnostic.
    expect(message).not.toContain("://");
  });
});

// The same refusal must arrive from every entry point — the Stack header path as
// well as `pickSearchRefs` — and none of them may print a configuration VALUE.
describe("S4 — every entry point refuses alike and prints no configuration value", () => {
  it("refuses a Stack whose stored header disagrees, before any ranking", async () => {
    useActiveConfig();
    const root = await seedProject();
    const segments = { model: STORED_MODEL, dimensions: STORED_DIMENSIONS };
    const source = {
      read: async () => ({ kind: "absent" as const }),
      readMeta: async () => segments,
      rankChunks: async (): Promise<ChunkRanking> => ({ kind: "ranked", hits: [] }),
    };

    const refusal = await errorFrom(loadMetaForSearch(root, source));

    expect(refusal?.name).toBe("EmbeddingSpaceMismatchError");
    expect(refusal?.message).toContain(`"${STORED_MODEL}"`);
  });

  it("names both sides without ever printing an environment variable's value", async () => {
    useActiveConfig({ OPENAI_EMBEDDINGS_BASE_URL: "http://vllm-embeddings.internal:8000/v1" });
    const root = await seedProject(storeOf({ model: STORED_MODEL }));

    const refusal = await errorFrom(pickSearchRefs(root, "what is alpha?"));

    // Model ids and dimension counts are configuration; an endpoint may carry a
    // credential as userinfo or a query parameter, so it must never be printed.
    expect(refusal?.message).toContain(`"${STORED_MODEL}"`);
    expect(refusal?.message).not.toContain("vllm-embeddings.internal");
    expect(refusal?.message).not.toContain("8000");
  });
});

describe("S5 — with no store to disagree with, retrieval keeps degrading", () => {
  it("still degrades an absent store instead of refusing it", async () => {
    useActiveConfig();
    const root = await seedProject();

    const outcome = await loadEmbeddingsForSearch(root);

    // A first-run deployment has nothing to be wrong about; refusing here would
    // break every fresh install.
    expect(outcome.store).toBeNull();
    expect(outcome.warnings.map((warning) => warning.code)).toEqual(["embedding-index-outdated"]);
  });
});

describe("S6 — agreement is unchanged", () => {
  it("returns the scored hits of a matching store with nothing surfaced", async () => {
    useActiveConfig();
    const root = await seedProject(storeOf());
    const embed = mockEmbedding(wideVector());

    const { refs, warnings } = await pickSearchRefs(root, "what is alpha?");

    expect(refs.map((ref) => ref.pageId)).toEqual(["concepts/alpha"]);
    expect(warnings).toEqual([]);
    // The candidates really were scored: the embedder ran exactly once.
    expect(embed).toHaveBeenCalledTimes(1);
  });
});

describe("S1 — a query vector of the wrong width is refused too", () => {
  it("names the width it got and the width the store holds", async () => {
    useActiveConfig();
    const root = await seedProject(storeOf());
    mockEmbedding(Array.from({ length: 1536 }, (_unused, index) => (index === 0 ? 1 : 0)));

    const refusal = await errorFrom(pickSearchRefs(root, "what is alpha?"));

    expect(refusal?.name).toBe("EmbeddingIntegrityError");
    expect(refusal?.message).toContain("1536");
    expect(refusal?.message).toContain(`${STORED_DIMENSIONS}`);
  });
});

describe("S2 — the SQL ranking path refuses, it does not degrade", () => {
  it("throws the named refusal for a header from another space", async () => {
    useActiveConfig();
    const db = scriptedDb([[integrityRow({ model: STORED_MODEL, fingerprint: null })]]);

    const refusal = await errorFrom(rankChunksInSql(db.handle, STACK_ID, wideVector(), 5, OPEN_SCOPE));

    // The same error class and the same message as the in-memory path, so a caller
    // that handles one retrieval path handles both.
    expect(refusal?.name).toBe("EmbeddingSpaceMismatchError");
    expectSpaceRefusalNamesBothSides(refusal, { model: STORED_MODEL, dimensions: STORED_DIMENSIONS }, ACTIVE_MODEL);
    // Only the tenant bind and the integrity probe ran: nothing was ranked.
    expect(db.statements()).toBe(2);
  });

  it("still ranks a matching store's chunks", async () => {
    useActiveConfig();
    const hit = { page_directory: "concepts", slug: "alpha", chunk_index: 0, cosine: 0.75, content_hash: "h1" };
    const db = scriptedDb([[integrityRow()], [hit]]);

    const ranking = await rankChunksInSql(db.handle, STACK_ID, wideVector(), 5, OPEN_SCOPE);

    expect(ranking.kind).toBe("ranked");
    expect(ranking.kind === "ranked" ? ranking.hits : []).toEqual([
      { pageDirectory: "concepts", slug: "alpha", chunkIndex: 0, cosine: 0.75, contentHash: "h1" },
    ]);
    expect(db.statements()).toBe(3);
  });

  it("still degrades a Stack that never recorded a header", async () => {
    useActiveConfig();
    const db = scriptedDb([[]]);

    const ranking = await rankChunksInSql(db.handle, STACK_ID, wideVector(), 5, OPEN_SCOPE);

    // S5 on the SQL path: absent is not a disagreement.
    expect(ranking).toEqual({
      kind: "degraded",
      code: "embedding-index-outdated",
      reason: "No embedding index found.",
    });
  });
});
