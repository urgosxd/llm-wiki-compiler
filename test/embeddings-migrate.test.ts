/**
 * @file test/embeddings-migrate.test.ts
 * @description The pure `migrateEmbeddingStore` reconciliation core.
 *
 * ## What this suite used to assert, and why it changed
 *
 * It used to prove that a v2 record could be PRESERVED: re-keyed from a bare
 * `slug` to a qualified `pageId`, with its vector carried forward whenever the
 * content still hashed the same. That path is retired, so those cases are gone
 * rather than adjusted.
 *
 * The reason is worth recording, because the code looked careful. Preserving a v2
 * vector required guessing which live page an old slug belonged to. The guess was
 * guarded -- a slug mapping to two pages was discarded, a changed hash triggered a
 * re-embed -- but every failure mode that slipped through was SILENT: the store
 * ended up holding a vector built from one page's text under another page's
 * identity, and similarity search then answered with that page for content it never
 * embedded. A wrong answer, not an error, and nothing downstream could detect it.
 *
 * Rebuilding costs provider work on the one upgrade where a legacy store appears,
 * and cannot attach a vector to the wrong page.
 *
 * ## Invariants under test
 *
 *  - a v1 or v2 store is REBUILT: empty entries/chunks, every eligible page queued.
 *  - a missing store rebuilds too (a clean project), never an error.
 *  - a healthy v3 store is RECONCILED by `pageId`: unchanged records survive,
 *    drifted ones re-embed, deleted ones are pruned without re-embedding.
 *  - a stored model different from the active one rebuilds; so does a corrupt store.
 *  - a rebuild returns `dimensions: 0`, never the old store's dimension. A stale
 *    nonzero value would make the writer validate freshly-embedded vectors of a new
 *    model's length against the wrong expected size and reject them, wedging
 *    embeddings permanently.
 *  - S2 privacy: `reembedPageIds` only ever names pages present in
 *    `eligibleLivePages`.
 */
import { describe, it, expect } from "vitest";
import { migrateEmbeddingStore } from "../src/utils/embeddings-migrate.js";
import type { EligibleLivePage } from "../src/utils/embeddings-migrate.js";
import type { ParsedStore, PageEmbeddingV3, ChunkEmbeddingV3 } from "../src/utils/embeddings-store.js";

const MODEL = "voyage-3";

/** A parsed legacy store, shaped the way a v1/v2 file would parse. */
function legacy(version: 1 | 2, entries: unknown[], chunks?: unknown[]): ParsedStore {
  return { version, store: { version, model: MODEL, dimensions: 2, entries, chunks } };
}

/** A parsed v3 store. */
function v3(entries: PageEmbeddingV3[], chunks: ChunkEmbeddingV3[] = []): ParsedStore {
  return { version: 3, store: { version: 3, model: MODEL, dimensions: 2, entries, chunks } };
}

/** An eligible live page with the hashes a v3 record must match to survive. */
function live(pageId: string, textHash: string, chunkHashes: string[] = []): EligibleLivePage {
  return { pageId, bareSlug: pageId.split("/")[1] ?? pageId, embeddingTextHash: textHash, chunkContentHashes: chunkHashes };
}

/** A v3 page record. */
function pageRecord(pageId: string, textHash: string): PageEmbeddingV3 {
  return { pageId, title: "T", summary: "S", embeddingTextHash: textHash, vector: [0.5, 0.5], updatedAt: "2026-01-01T00:00:00.000Z" };
}

/** A v3 chunk record. */
function chunkRecord(pageId: string, index: number, contentHash: string): ChunkEmbeddingV3 {
  return { pageId, title: "T", chunkIndex: index, contentHash, text: "body", vector: [0.5, 0.5], updatedAt: "2026-01-01T00:00:00.000Z" };
}

/**
 * Assert the store was REBUILT: nothing preserved, everything needs re-embedding.
 *
 * A rebuild is one decision with two observable halves -- an empty entry list and the
 * full page set queued for re-embedding -- and asserting only one of them would pass
 * over a store that kept stale vectors while still queuing work. Three cases asserted
 * the pair, which fallow flagged; one helper keeps the halves together.
 *
 * @param result - What `migrateEmbeddingStore` returned.
 * @param expectedPageIds - Pages that must be queued for re-embedding.
 */
function expectRebuild(
  result: ReturnType<typeof migrateEmbeddingStore>,
  expectedPageIds: readonly string[],
): void {
  expect(result.store.entries).toEqual([]);
  expect(result.reembedPageIds).toEqual(expectedPageIds);
}

describe("migrateEmbeddingStore — legacy stores rebuild", () => {
  it("rebuilds a v1 store instead of guessing which page its slug belonged to", () => {
    const result = migrateEmbeddingStore(
      legacy(1, [{ slug: "alpha", title: "T", summary: "S", vector: [0.5, 0.5], updatedAt: "x" }]),
      [live("concepts/alpha", "hash-a")],
      MODEL,
    );

    // Nothing is preserved: a bare slug cannot prove it addresses concepts/alpha
    // rather than queries/alpha, and a wrong pairing is undetectable later.
    expectRebuild(result, ["concepts/alpha"]);
  });

  it("rebuilds a v2 store that also carried chunks", () => {
    const result = migrateEmbeddingStore(
      legacy(
        2,
        [{ slug: "alpha", title: "T", summary: "S", vector: [0.5, 0.5], updatedAt: "x" }],
        [{ slug: "alpha", title: "T", chunkIndex: 0, contentHash: "c", text: "b", vector: [0.5, 0.5], updatedAt: "x" }],
      ),
      [live("concepts/alpha", "hash-a", ["c"])],
      MODEL,
    );

    expect(result.store.chunks).toEqual([]);
    expect(result.reembedPageIds).toEqual(["concepts/alpha"]);
  });

  it("rebuilds when there is no store at all, which is the clean-project case", () => {
    const result = migrateEmbeddingStore(null, [live("concepts/alpha", "hash-a")], MODEL);

    expectRebuild(result, ["concepts/alpha"]);
  });

  it("reports dimensions 0 on a rebuild, never the discarded store's dimension", () => {
    // A stale nonzero dimension makes the writer reject every fresh vector of a new
    // model's length, and every later compile repeats the same rejection.
    const result = migrateEmbeddingStore(
      legacy(2, [{ slug: "a", title: "T", summary: "S", vector: [0.5, 0.5], updatedAt: "x" }]),
      [live("concepts/a", "h")],
      MODEL,
    );

    expect(result.store.dimensions).toBe(0);
  });

  it("rebuilds when the stored model differs from the active one", () => {
    const stored = v3([pageRecord("concepts/alpha", "hash-a")]);
    stored.store.model = "some-other-model";

    const result = migrateEmbeddingStore(stored, [live("concepts/alpha", "hash-a")], MODEL);

    expectRebuild(result, ["concepts/alpha"]);
  });
});

describe("migrateEmbeddingStore — v3 reconciliation", () => {
  it("keeps a record whose embedding text is unchanged, and does not re-embed it", () => {
    const result = migrateEmbeddingStore(
      v3([pageRecord("concepts/alpha", "hash-a")]),
      [live("concepts/alpha", "hash-a")],
      MODEL,
    );

    expect(result.store.entries).toHaveLength(1);
    expect(result.store.entries[0]?.pageId).toBe("concepts/alpha");
    expect(result.reembedPageIds).toEqual([]);
  });

  it("re-embeds a record whose embedding text drifted", () => {
    const result = migrateEmbeddingStore(
      v3([pageRecord("concepts/alpha", "old-hash")]),
      [live("concepts/alpha", "new-hash")],
      MODEL,
    );

    expectRebuild(result, ["concepts/alpha"]);
  });

  it("prunes a deleted page without re-embedding it", () => {
    // S2 privacy: the page no longer exists, so asking the provider to embed it
    // would be work for content that is gone.
    const result = migrateEmbeddingStore(v3([pageRecord("concepts/gone", "h")]), [], MODEL);

    expect(result.store.entries).toEqual([]);
    expect(result.reembedPageIds).toEqual([]);
  });

  it("keeps a chunk whose content hash matches at the same index", () => {
    const result = migrateEmbeddingStore(
      v3([pageRecord("concepts/a", "h")], [chunkRecord("concepts/a", 0, "c0"), chunkRecord("concepts/a", 1, "c1")]),
      [live("concepts/a", "h", ["c0", "c1"])],
      MODEL,
    );

    expect(result.store.chunks).toHaveLength(2);
    expect(result.reembedPageIds).toEqual([]);
  });

  it("re-embeds a page whose chunk hash changed at the same index", () => {
    const result = migrateEmbeddingStore(
      v3([pageRecord("concepts/a", "h")], [chunkRecord("concepts/a", 0, "stale")]),
      [live("concepts/a", "h", ["fresh"])],
      MODEL,
    );

    expect(result.store.chunks).toEqual([]);
    expect(result.reembedPageIds).toEqual(["concepts/a"]);
  });

  it("is idempotent on a healthy v3 store", () => {
    const healthy = v3([pageRecord("concepts/a", "h")]);
    const first = migrateEmbeddingStore(healthy, [live("concepts/a", "h")], MODEL);
    const second = migrateEmbeddingStore(healthy, [live("concepts/a", "h")], MODEL);

    expect(second).toEqual(first);
  });
});
