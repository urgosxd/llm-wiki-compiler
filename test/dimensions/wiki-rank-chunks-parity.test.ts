/**
 * @file test/dimensions/wiki-rank-chunks-parity.test.ts
 * @description Executable specification for `rankChunks`: the SQL chunk ranking
 * must return what the in-memory ranking returns, over the SAME corpus, and must
 * never return a chunk the in-memory path would have filtered out.
 *
 * ## Why this corpus is SEEDED, not the production one
 *
 * Comparing two sets proves nothing if no row discriminates them. Measured on the
 * real Stack (`d61bf181`): `archived=true` 0 rows, `orphaned=true` 0 rows,
 * `title=''` 0 rows, 504 total. A translation that added an `archived` exclusion —
 * which the live predicate does NOT have — reported "0 missing, 0 extra" because
 * both sides were "every row". Two people verified that false equality before
 * anyone seeded a row that falls on one side only.
 *
 * So every case below seeds the classes that DIFFER, and asserts the direction
 * each one falls:
 *
 *   normal    -> included by both
 *   orphaned  -> excluded by both (`isLegacyScanEligible`)
 *   archived  -> INCLUDED by both, deliberately pinned
 *   untitled  -> excluded by both (`hasTitle`)
 *   out-of-scope -> excluded by the caller's pageScope
 *
 * `untitled` is not hypothetical: `title` is `not null default ''` in
 * `wiki.pages`, and `isLegacyScanEligible` requires `hasTitle`.
 *
 * ## Why the SQL predicate has no `archived` term
 *
 * `isLegacyScanEligible` (`page-registry.ts:174`) is
 * `orphaned !== true && hasTitle` — `archived` is absent. Archiving is a
 * FRESHNESS signal, not an eligibility gate: `context/ranking.ts` surfaces
 * `archived-page` as a warning while still returning the page, and the file-backed
 * path has no such concept at all. Excluding archived chunks in SQL would make the
 * two paths non-parity on an axis only one of them knows about.
 *
 * ## Why a missing `rankChunks` fails LOUDLY
 *
 * A fallback to the in-memory path would make every parity case here compare the
 * in-memory path against itself: green, and worthless. {@link requireRankChunks}
 * therefore throws when the capability is absent, so "not implemented yet" reads
 * as a failure instead of a pass.
 *
 * ## Why `excludedNamespaces` is tested directly
 *
 * The DB adapter cannot reach it through the product: `wiki.pages.page_directory`
 * is constrained to `('concepts','queries')`, both reserved, and the reserved
 * branch of every eligibility gate ignores the profile's retrieval flags entirely.
 * Typed namespaces live only in files, and cannot be rows (the chunk table has a
 * foreign key to `wiki.pages`). Case 3 tests the ADAPTER'S CONTRACT — asked to
 * exclude a namespace, it returns nothing from it — rather than a product state
 * that cannot occur.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { databaseEmbeddingSource } from "../../src/utils/embeddings-database.js";
import { writeEmbeddingStoreToDb, toVectorLiteral } from "../../src/utils/embeddings-database-write.js";
import { cosineSimilarity } from "../../src/utils/embeddings-search.js";
import { createRegistryPageSource } from "../../src/dimensions/wiki/page-registry-source.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** The ranking contract this file specifies. Absent until the adapter implements it. */
interface RankedChunk {
  readonly pageDirectory: string;
  readonly slug: string;
  readonly chunkIndex: number;
  readonly cosine: number;
}

/** The scope every case passes; mirrors the shape agreed for `rankChunks`. */
interface RankScope {
  readonly pageScope?: readonly string[];
  readonly excludedNamespaces: readonly string[];
  readonly surface: "search" | "context";
}

/** A source that may or may not carry the ranking capability yet. */
interface RankChunksCapable {
  rankChunks?(queryVec: number[], k: number, scope: RankScope): Promise<RankedChunk[]>;
}

/** Dimensions of every vector in this file; matches the shipped column width. */
const DIMS = 768;

/** Unrestricted scope over the search surface. */
const OPEN_SCOPE: RankScope = { excludedNamespaces: [], surface: "search" };

/** One class of page this file discriminates on. */
interface SeedClass {
  readonly slug: string;
  readonly title: string;
  readonly orphaned: boolean;
  readonly archived: boolean;
}

/**
 * A 768-dimension vector pointing mostly along one axis.
 *
 * Cosine order over these is exactly the `seed` order, which is what lets the
 * assertions state an expected ranking instead of comparing two black boxes.
 */
function vector(seed: number): number[] {
  const values = new Array<number>(DIMS).fill(0.5);
  values[0] = seed;
  return values;
}

/** One chunk entry for a page, standing at `seed` on the similarity axis. */
function chunkEntry(slug: string, seed: number): ChunkEmbeddingV3 {
  return {
    pageId: `concepts/${slug}`,
    title: `Title ${slug}`,
    chunkIndex: 0,
    contentHash: `chunk-hash-${slug}`,
    text: `chunk text ${slug}`,
    vector: vector(seed),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A v3 store carrying one chunk per seeded page. */
function storeOf(chunks: ChunkEmbeddingV3[]): EmbeddingStoreV3 {
  return { version: 3, model: "nomic-embed-text-v1.5", dimensions: DIMS, entries: [], chunks };
}

/**
 * Resolve the capability, or fail loudly.
 *
 * @param source - Any embedding store source.
 * @returns The ranking function.
 */
function requireRankChunks(source: unknown): RankChunksCapable["rankChunks"] {
  const fn = (source as RankChunksCapable).rankChunks;
  if (fn === undefined) {
    throw new Error(
      "rankChunks is not implemented on this source. Parity cannot be asserted against " +
        "the in-memory path itself -- implement the capability instead of falling back.",
    );
  }
  return fn.bind(source);
}

describe("SQL chunk ranking", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`rank-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /**
   * Write one page row with the flags that decide eligibility.
   *
   * `title` is written verbatim so an empty one can be seeded: the column is
   * `not null default ''`, and `hasTitle` is `title !== ''`.
   */
  async function seedPage(page: SeedClass): Promise<void> {
    await harness.db.execute(`
      insert into wiki.pages (stack_id, page_directory, slug, title, orphaned, archived)
      values ('${harness.stackId}', 'concepts', '${page.slug}', '${page.title}',
              ${page.orphaned}, ${page.archived})
    `);
  }

  /** The five classes, at descending similarity so the expected order is stable. */
  const CLASSES: readonly SeedClass[] = [
    { slug: "normal", title: "Normal", orphaned: false, archived: false },
    { slug: "archived", title: "Archived", orphaned: false, archived: true },
    { slug: "orphaned", title: "Orphaned", orphaned: true, archived: false },
    { slug: "untitled", title: "", orphaned: false, archived: false },
    { slug: "outside", title: "Outside", orphaned: false, archived: false },
  ];

  /** Similarity seed per slug, descending in {@link CLASSES} order. */
  const SEEDS: Readonly<Record<string, number>> = {
    normal: 0.9, archived: 0.8, orphaned: 0.7, untitled: 0.6, outside: 0.5,
  };

  /** Seed all five pages and every chunk vector they own. */
  async function seedAll(): Promise<EmbeddingStoreV3> {
    for (const page of CLASSES) await seedPage(page);
    const chunks = CLASSES.map((page) => chunkEntry(page.slug, SEEDS[page.slug] as number));
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, storeOf(chunks));
    return storeOf(chunks);
  }

  /**
   * Reference ranking: what the in-memory path produces over the LIVE corpus.
   *
   * Eligibility comes from the adapter's `liveIds`, which is the production gate;
   * scope is applied here the way `narrowToScope` does. Ordering is plain cosine,
   * the same comparison `scoreChunkEntries` performs.
   */
  async function rankInMemory(
    chunks: readonly ChunkEmbeddingV3[],
    queryVec: number[],
    k: number,
    scope: RankScope = OPEN_SCOPE,
  ): Promise<string[]> {
    const dirs = new Map([["concepts", "wiki/concepts"], ["queries", "wiki/queries"]]);
    const live = await createRegistryPageSource(
      harness.db as never, harness.stackId,
    ).liveIds(["concepts", "queries"], dirs, undefined);
    return chunks
      .filter((chunk) => live.has(chunk.pageId))
      .filter((chunk) => scope.pageScope === undefined || scope.pageScope.includes(chunk.pageId))
      .map((chunk) => ({ id: chunk.pageId, score: cosineSimilarity(queryVec, chunk.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((scored) => scored.id);
  }

  /** Rank through the SQL capability and project to page ids, in returned order. */
  async function rankViaSql(
    queryVec: number[],
    k: number,
    scope: RankScope = OPEN_SCOPE,
  ): Promise<string[]> {
    const source = databaseEmbeddingSource(harness.db as never, harness.stackId);
    const rankChunks = requireRankChunks(source);
    const ranked = await rankChunks!(queryVec, k, scope);
    return ranked.map((hit) => `${hit.pageDirectory}/${hit.slug}`);
  }

  it("returns the same top-k as the in-memory path on the seeded corpus", async () => {
    const chunks = await seedAll();

    const viaSql = await rankViaSql(vector(0.85), 5);
    const viaMemory = await rankInMemory(chunks.chunks ?? [], vector(0.85), 5);

    // The corpus cannot be the whole table, or the assertion is vacuous: the
    // expected set must be a strict subset of what was seeded.
    expect(viaMemory.length).toBeLessThan(CLASSES.length);
    expect(viaSql).toEqual(viaMemory);
  });

  it("excludes orphaned and untitled pages, and INCLUDES archived ones", async () => {
    await seedAll();

    const ranked = await rankViaSql(vector(0.85), 5);

    expect(ranked).toContain("concepts/normal");
    // Pinned deliberately: `isLegacyScanEligible` does not test `archived`, and
    // archiving is a freshness warning, not an eligibility gate.
    expect(ranked).toContain("concepts/archived");
    expect(ranked).not.toContain("concepts/orphaned");
    expect(ranked).not.toContain("concepts/untitled");
  });

  it("never returns a chunk outside the caller's page scope", async () => {
    await seedAll();

    const ranked = await rankViaSql(vector(0.85), 5, {
      pageScope: ["concepts/outside"], excludedNamespaces: [], surface: "search",
    });

    // One in-scope page, so exactly one hit -- and no leak from the higher seeds.
    expect(ranked).toEqual(["concepts/outside"]);
  });

  it("returns nothing from an excluded namespace", async () => {
    await seedAll();

    const ranked = await rankViaSql(vector(0.85), 5, {
      excludedNamespaces: ["concepts"], surface: "search",
    });

    expect(ranked).toEqual([]);
  });

  it("scores every returned hit with an EXACT cosine, not a distance", async () => {
    const chunks = await seedAll();
    const queryVec = vector(0.85);
    const source = databaseEmbeddingSource(harness.db as never, harness.stackId);
    const rankChunks = requireRankChunks(source);

    const ranked = await rankChunks!(queryVec, 5, OPEN_SCOPE);

    for (const hit of ranked) {
      const seeded = (chunks.chunks ?? []).find(
        (chunk) => chunk.pageId === `${hit.pageDirectory}/${hit.slug}`,
      );
      expect(seeded).toBeDefined();
      // The floor compares this value, so it must be the same number the
      // in-memory path would compare -- not `1 - dist` from an approximate scan.
      expect(Math.abs(hit.cosine - cosineSimilarity(queryVec, seeded!.vector))).toBeLessThan(1e-6);
    }
  });

  it("falls back to the in-memory path when the source has no rankChunks", async () => {
    const chunks = await seedAll();
    const withoutCapability = { read: databaseEmbeddingSource(
      harness.db as never, harness.stackId,
    ).read };

    expect(requireRankCapability(withoutCapability)).toBeUndefined();
    // The fallback must reproduce the in-memory answer exactly: `outside` is LIVE
    // (not orphaned, titled) and an open scope does not narrow it away, so it
    // ranks third. Only orphaned and untitled are dropped.
    const expected = await rankInMemory(chunks.chunks ?? [], vector(0.85), 5);
    expect(expected).toEqual(["concepts/normal", "concepts/archived", "concepts/outside"]);
  });
});

/**
 * Read the capability WITHOUT requiring it, for the fallback case.
 *
 * @param source - Any embedding store source.
 * @returns The ranking function, or undefined when the adapter cannot rank.
 */
function requireRankCapability(source: unknown): RankChunksCapable["rankChunks"] {
  return (source as RankChunksCapable).rankChunks;
}
