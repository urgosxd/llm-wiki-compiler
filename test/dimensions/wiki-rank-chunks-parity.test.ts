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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { databaseEmbeddingSource, readEmbeddingStoreFromDb } from "../../src/utils/embeddings-database.js";
import { resolveEmbeddingModel, resolveEmbeddingFingerprint } from "../../src/utils/embeddings-store.js";
import { writeEmbeddingStoreToDb } from "../../src/utils/embeddings-database-write.js";
import { cosineSimilarity } from "../../src/utils/embeddings-search.js";
import { createRegistryPageSource } from "../../src/dimensions/wiki/page-registry-source.js";
import { findRelevantChunksV3 } from "../../src/utils/embeddings-load.js";
import * as providerMod from "../../src/utils/provider.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { provisionStack } from "../fixtures/stack-harness.js";

/** The ranking contract this file specifies. Absent until the adapter implements it. */
interface RankedChunk {
  readonly pageDirectory: string;
  readonly slug: string;
  readonly chunkIndex: number;
  readonly cosine: number;
  readonly contentHash: string;
}

/** The outcome a ranking attempt returns: ranked, or degraded with a code. */
type ChunkRanking =
  | { readonly kind: "ranked"; readonly hits: RankedChunk[] }
  | { readonly kind: "degraded"; readonly code: string; readonly reason: string };

/** The scope every case passes; mirrors the shape agreed for `rankChunks`. */
interface RankScope {
  readonly pageScope?: readonly string[];
  readonly excludedNamespaces: readonly string[];
  readonly surface: "search" | "context";
}

/** A source that may or may not carry the ranking capability yet. */
interface RankChunksCapable {
  rankChunks?(queryVec: number[], k: number, scope: RankScope): Promise<ChunkRanking>;
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
 *
 * ## Why the fill is 0.5 and not the more idiomatic 0.01
 *
 * `wiki.page_chunk_embeddings.vector` is `vector(768)`, i.e. **float4**, and
 * `0.01` is not exactly representable there while `0.5` is. With `0.01`, all 768
 * components are already slightly wrong before pgvector does any arithmetic, and
 * the accumulated error reaches ~3.1e-06 -- above the 1e-6 tolerance below, so the
 * case failed for a property of this fixture rather than of the contract.
 *
 * Measured against the real database, worst |cosine_SQL - cosine_JS| over the five
 * seeds: fill 0.01 -> 3.11e-06, fill 0.5 -> 4.60e-08. Rounding the JS reference
 * through `Math.fround` does NOT rescue 0.01 (still 3.11e-06), because the error
 * comes from float4 ACCUMULATION inside pgvector, not from input quantization.
 *
 * With 0.5 the tolerance below tests real numeric parity. The similarity order is
 * unchanged, since it is monotone in `seed` either way.
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

/**
 * A v3 store carrying one chunk per seeded page, stamped with the ACTIVE config.
 *
 * ## Why the model and fingerprint are resolved, never hardcoded
 *
 * These are the inputs to `storeMatchesActiveEmbedding`, the stale-configuration
 * gate. A store that fails it never reaches the ranking, so every case in this file
 * would be asserting against a degraded outcome instead of a ranked one -- and, more
 * importantly, the gate itself would go untested by the file that specifies the
 * contract.
 *
 * Resolved rather than written literally because the active model is an ENVIRONMENT
 * fact: measured here it is `voyage-3-lite`, while the documented default is
 * `hf:nomic-ai/nomic-embed-text-v1.5`. A hardcoded name passes in one environment
 * and fails the gate in another, which reads as a ranking bug.
 */
function storeOf(chunks: ChunkEmbeddingV3[]): EmbeddingStoreV3 {
  return {
    version: 3,
    model: resolveEmbeddingModel(),
    fingerprint: resolveEmbeddingFingerprint(),
    dimensions: DIMS,
    entries: [],
    chunks,
  };
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
  let release: () => Promise<void>;

  beforeEach(async () => {
    // Shared fixture rather than the hand-rolled pair every dimension suite used
    // to duplicate; `fallow` flags that shape as a clone group.
    const provisioned = await provisionStack("rank");
    harness = provisioned.harness;
    release = provisioned.release;
  });

  afterEach(async () => {
    await release();
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
    const outcome = await rankChunks!(queryVec, k, scope);
    if (outcome.kind !== "ranked") throw new Error(`expected ranked, got degraded: ${outcome.code}`);
    return outcome.hits.map((hit) => `${hit.pageDirectory}/${hit.slug}`);
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

  it("reports a live, titled page whose stored hash is out of date as STALE, not as a hit", async () => {
    // CONTENT DRIFT, the one failure mode measured on the real corpus: 23 of 28
    // pages in stack 7f1b3b36. The page is live and titled, so every eligibility
    // filter passes it; only the hash comparison notices its vector is obsolete.
    //
    // This drives `findRelevantChunksV3` -- the public path that runs the walk --
    // rather than asserting the fixture. A case that only checks its own setup
    // passes no matter what the walk does.
    //
    // `rankChunks` replaces the SCORING, never the freshness walk. If a future
    // change skips the walk because "the join already filtered dead pages", this
    // goes red: the join cannot see drift, only absence.
    const body = "a body that hashes differently";
    await seedPage(CLASSES[0] as SeedClass);
    await harness.db.execute(
      `update wiki.pages set body = '${body}' where stack_id = '${harness.stackId}' and slug = 'normal'`,
    );
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, storeOf([
      { ...chunkEntry("normal", SEEDS.normal as number), contentHash: "a-hash-the-live-body-does-not-produce" },
    ]));
    const dirs = new Map([["concepts", "wiki/concepts"]]);
    const source = createRegistryPageSource(harness.db as never, harness.stackId);

    // Precondition: the stored hash genuinely differs from the live one, or the
    // case would pass for the wrong reason.
    const live = await source.liveEntry("concepts/normal", dirs);
    expect(live).not.toBeNull();
    expect(live?.chunkHashes[0]).not.toBe("a-hash-the-live-body-does-not-produce");

    // The behaviour under test: the drifted chunk is reported stale, not returned.
    const store = await readEmbeddingStoreFromDb(harness.db as never, harness.stackId);
    expect(store).not.toBeNull();
    vi.spyOn(providerMod, "getProvider").mockReturnValue({
      embed: async () => vector(SEEDS.normal as number),
      embedBatch: async (t: string[]) => t.map(() => vector(SEEDS.normal as number)),
    } as never);
    const outcome = await findRelevantChunksV3(
      "/nonexistent-root-forced-to-rows", store as EmbeddingStoreV3,
      "search", "q", 5, undefined, source,
    );

    expect(outcome.hits.map((hit) => hit.pageId)).not.toContain("concepts/normal");
    expect(outcome.stalePageIds).toContain("concepts/normal");
  });

  it("degrades with embedding-index-outdated when the store was built by another model", async () => {
    // The stale-configuration gate, covered by the file that specifies the
    // contract. Without this case the gate is untested here: every other case uses
    // a store that matches the active config, so deleting the gate would leave them
    // all green.
    //
    // This is also why the fixture resolves its model instead of hardcoding one --
    // a hardcoded name fails this gate in any environment whose active model
    // differs, and reads as a ranking bug rather than a fixture bug.
    await seedPage(CLASSES[0] as SeedClass);
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, {
      ...storeOf([chunkEntry("normal", SEEDS.normal as number)]),
      model: "definitely-not-the-active-model",
      fingerprint: "a-fingerprint-that-does-not-match",
    });
    const source = databaseEmbeddingSource(harness.db as never, harness.stackId);
    const rankChunks = requireRankChunks(source);

    const outcome = await rankChunks!(vector(0.85), 5, OPEN_SCOPE);

    expect(outcome.kind).toBe("degraded");
    if (outcome.kind !== "degraded") throw new Error("unreachable");
    expect(outcome.code).toBe("embedding-index-outdated");
  });

  it("treats the PREFILTER as the eligibility gate, not the hash read", async () => {
    // The eligibility gate lives in ONE place (`buildLiveIdSet`), and both backends
    // apply it there. An orphan's hashes are still readable on purpose: `liveEntry`
    // answers "what are this page's hashes, if it exists?" while `recordPairs`
    // answers "may I show this page as evidence?".
    //
    // The middle assertion is load-bearing: it stops anyone from "fixing" that
    // apparent asymmetry inside the hash read, which would make the row-backed and
    // disk-backed sources disagree -- the divergence `page-registry-source.ts`
    // exists to prevent.
    await seedPage({ slug: "dead", title: "Dead", orphaned: true, archived: false });
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, storeOf([chunkEntry("dead", 0.9)]));
    const source = createRegistryPageSource(harness.db as never, harness.stackId);
    const dirs = new Map([["concepts", "wiki/concepts"]]);

    const liveIds = await source.liveIds(["concepts"], dirs, undefined);
    expect(liveIds.has("concepts/dead")).toBe(false);

    const hashes = await source.liveEntry("concepts/dead", dirs);
    expect(hashes).not.toBeNull();

    const pairs = await source.recordPairs(["concepts/dead"]);
    expect(pairs).toEqual([]);
  });

  it("scores every returned hit with an EXACT cosine, not a distance", async () => {
    const chunks = await seedAll();
    const queryVec = vector(0.85);
    const source = databaseEmbeddingSource(harness.db as never, harness.stackId);
    const rankChunks = requireRankChunks(source);

    const outcome = await rankChunks!(queryVec, 5, OPEN_SCOPE);
    if (outcome.kind !== "ranked") throw new Error(`expected ranked, got ${outcome.kind}`);
    const ranked = outcome.hits;

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
