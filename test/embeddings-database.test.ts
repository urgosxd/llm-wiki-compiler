/**
 * @file test/embeddings-database.test.ts
 * @description Round-trip the page and chunk vectors through Postgres.
 *
 * ## What these cases are actually defending
 *
 * Moving the vectors out of `.llmwiki/embeddings.json` is only safe if the table
 * preserves the guarantees the file had. Three of them are easy to lose and none
 * would show up in a compile check:
 *
 *   - The HEADER must survive, because the read path gates on model, dimensions,
 *     and fingerprint before trusting a single vector.
 *   - The write must DELETE what it no longer covers, or a removed page stays
 *     retrievable from a corpus that claims to have dropped it.
 *   - The tenant must be bound, or every query returns zero rows for a Stack that
 *     genuinely has vectors.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createKgPostgresHarness, type KgPostgresHarness } from "./fixtures/kg-postgres.js";
import { provisionStack } from "./fixtures/stack-harness.js";
import {
  databaseEmbeddingLocation,
  databaseEmbeddingSink,
  databaseEmbeddingSource,
  readEmbeddingStoreFromDb,
  readEmbeddingMeta,
  splitPageId,
} from "../src/utils/embeddings-database.js";
import { loadEmbeddingsForSearch } from "../src/utils/embeddings-load.js";
import { collectStats } from "../src/eval/stats.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveEmbeddingModel } from "../src/utils/embeddings-store.js";
import {
  toVectorLiteral,
  writeEmbeddingStoreToDb,
} from "../src/utils/embeddings-database-write.js";
import type { ChunkEmbeddingV3, EmbeddingStoreV3, PageEmbeddingV3 } from "../src/utils/embeddings-store.js";

/** Probe whether the vector extension and the embedding tables are both present. */
const harnessReachable = await (async (): Promise<boolean> => {
  const probe = await createKgPostgresHarness(`emb-probe-${randomUUID().slice(0, 8)}`);
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive probe */
  try {
    await probe.db.execute("select 1 from wiki.embedding_store_meta limit 1");
    return probe.reachable;
  } catch {
    return false;
  } finally {
    await probe.cleanup();
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
})();

/** A 768-dimension vector, uniform except for one distinguishable component. */
function vector(seed: number): number[] {
  const values = new Array<number>(768).fill(0.01);
  values[0] = seed;
  return values;
}

/** One page entry with a valid qualified id. */
function pageEntry(pageId: string, seed: number): PageEmbeddingV3 {
  return {
    pageId,
    title: `Title ${pageId}`,
    summary: `Summary ${pageId}`,
    embeddingTextHash: `hash-${seed}`,
    vector: vector(seed),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** One chunk entry belonging to the given page. */
function chunkEntry(pageId: string, chunkIndex: number, seed: number): ChunkEmbeddingV3 {
  return {
    pageId,
    title: `Title ${pageId}`,
    chunkIndex,
    contentHash: `chunk-hash-${seed}`,
    text: `chunk text ${seed}`,
    vector: vector(seed),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A complete v3 store over the given entries. */
function store(entries: PageEmbeddingV3[], chunks: ChunkEmbeddingV3[] = []): EmbeddingStoreV3 {
  return { version: 3, model: "nomic-embed-text-v1.5", dimensions: 768, entries, chunks };
}

/** Insert the page rows the embedding foreign key requires. */
async function seedPages(harness: KgPostgresHarness, pageIds: readonly string[]): Promise<void> {
  for (const pageId of pageIds) {
    const split = splitPageId(pageId);
    if (split === null) throw new Error(`test fixture used a malformed page id: ${pageId}`);
    await harness.db.execute(
      `insert into wiki.pages (stack_id, page_directory, slug, title) values ('${harness.stackId}', '${split.pageDirectory}', '${split.slug}', 'T')`,
    );
  }
}

/**
 * Write one store and read it straight back.
 *
 * Eight cases in this file perform exactly this pair, and several wrap it across
 * lines only because the store literal is long; sharing it also makes clear that the
 * READ always follows the LAST write, which is the property every case asserts.
 *
 * @param harness - Stack to write into and read from.
 * @param written - The store to persist.
 * @returns Whatever the reader returned.
 */
async function writeThenRead(
  harness: KgPostgresHarness,
  written: Parameters<typeof writeEmbeddingStoreToDb>[2],
): Promise<Awaited<ReturnType<typeof readEmbeddingStoreFromDb>>> {
  await writeEmbeddingStoreToDb(harness.db, harness.stackId, written);
  return readEmbeddingStoreFromDb(harness.db, harness.stackId);
}

describe.skipIf(!harnessReachable)("embedding vectors in Postgres", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = (await provisionStack("emb")).harness;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("round-trips the header and page vectors without loss", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    const written = { ...store([pageEntry("concepts/alpha", 0.5)]), fingerprint: "fp-1" };

    await writeEmbeddingStoreToDb(harness.db, harness.stackId, written);
    const read = await readEmbeddingStoreFromDb(harness.db, harness.stackId);

    expect(read?.model).toBe("nomic-embed-text-v1.5");
    expect(read?.dimensions).toBe(768);
    expect(read?.fingerprint).toBe("fp-1");
    expect(read?.entries).toHaveLength(1);
    expect(read?.entries[0]?.pageId).toBe("concepts/alpha");
    expect(read?.entries[0]?.vector[0]).toBeCloseTo(0.5);
    expect(read?.entries[0]?.embeddingTextHash).toBe("hash-0.5");
    expect(read?.entries[0]?.vector).toHaveLength(768);
  });

  it("omits the fingerprint when the store had none, so an old store stays comparable on model", async () => {
    await seedPages(harness, ["concepts/alpha"]);

    const read = await writeThenRead(harness, store([pageEntry("concepts/alpha", 0.3)]));

    // Absent, not empty string: `storeMatchesActiveEmbedding` falls back to `model`
    // only when the field is missing entirely.
    expect(read).not.toHaveProperty("fingerprint");
  });

  it("reports null rather than an empty store when the Stack has no header", async () => {
    // Absence must be distinguishable from an empty store: the caller treats "never
    // embedded" as a reason to build, and a corrupt header as a reason to degrade.
    expect(await readEmbeddingStoreFromDb(harness.db, harness.stackId)).toBeNull();
    expect(await readEmbeddingMeta(harness.db, harness.stackId)).toBeNull();
  });

  it("deletes vectors for pages the new store no longer contains", async () => {
    await seedPages(harness, ["concepts/alpha", "concepts/beta"]);
    await writeEmbeddingStoreToDb(
      harness.db,
      harness.stackId,
      store([pageEntry("concepts/alpha", 0.1), pageEntry("concepts/beta", 0.2)]),
    );

    const read = await writeThenRead(harness, store([pageEntry("concepts/alpha", 0.1)]));

    // The second write covers only alpha, so beta's vector must be gone rather than
    // left retrievable from a corpus that no longer lists it.
    expect(read?.entries.map((e) => e.pageId)).toEqual(["concepts/alpha"]);
  });

  it("clears every vector when the store becomes empty", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, store([pageEntry("concepts/alpha", 0.1)]));

    const read = await writeThenRead(harness, store([]));

    expect(read?.entries).toEqual([]);
  });

  it("round-trips chunk vectors keyed by page and index", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    await writeEmbeddingStoreToDb(
      harness.db,
      harness.stackId,
      store([pageEntry("concepts/alpha", 0.1)], [
        chunkEntry("concepts/alpha", 0, 0.11),
        chunkEntry("concepts/alpha", 1, 0.12),
      ]),
    );

    const read = await readEmbeddingStoreFromDb(harness.db, harness.stackId);

    expect(read?.chunks).toHaveLength(2);
    expect(read?.chunks?.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(read?.chunks?.[1]?.text).toBe("chunk text 0.12");
  });

  it("drops chunk rows the new store no longer covers while keeping the rest", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    await writeEmbeddingStoreToDb(
      harness.db,
      harness.stackId,
      store([pageEntry("concepts/alpha", 0.1)], [chunkEntry("concepts/alpha", 0, 0.11)]),
    );

    const read = await writeThenRead(harness, store([pageEntry("concepts/alpha", 0.1)]));

    expect(read?.chunks).toEqual([]);
  });

  it("keeps two Stacks' vectors apart even though both are written through one handle", async () => {
    const other = await createKgPostgresHarness(`emb-other-${randomUUID().slice(0, 8)}`);
    try {
      await seedPages(harness, ["concepts/alpha"]);
      await seedPages(other, ["concepts/other"]);
      await writeEmbeddingStoreToDb(harness.db, harness.stackId, store([pageEntry("concepts/alpha", 0.1)]));
      await writeEmbeddingStoreToDb(other.db, other.stackId, store([pageEntry("concepts/other", 0.9)]));

      const mine = await readEmbeddingStoreFromDb(harness.db, harness.stackId);
      const theirs = await readEmbeddingStoreFromDb(other.db, other.stackId);

      expect(mine?.entries.map((e) => e.pageId)).toEqual(["concepts/alpha"]);
      expect(theirs?.entries.map((e) => e.pageId)).toEqual(["concepts/other"]);
    } finally {
      await other.cleanup();
    }
  });

  it("renders a vector literal pgvector accepts and refuses a non-finite component", () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe("[1,2.5,-3]");
    // NaN survives a round trip but poisons every cosine score it touches, so it is
    // refused at the boundary instead of being written.
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(/non-finite/);
  });
});

/**
 * Assert the loader refused the Stack's store as outdated.
 *
 * Both cases below end in exactly this pair -- `null` store plus the
 * `embedding-index-outdated` code -- and asserting only the first half would pass
 * while the caller lost the reason it branches on.
 *
 * @param harness - Stack to load from.
 * @returns The load outcome.
 */
async function expectOutdatedStore(
  harness: KgPostgresHarness,
): Promise<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>> {
  const outcome = await loadEmbeddingsForSearch("", databaseEmbeddingSource(harness.db, harness.stackId));
  expect(outcome.store).toBeNull();
  expect(outcome.warnings.map((w) => w.code)).toContain("embedding-index-outdated");
  return outcome;
}

/**
 * Write a store through the paired sink and load it back through the same location.
 *
 * Both halves must address the SAME Stack; that is the property these cases assert,
 * and it was set up twice. Sharing it also means a case cannot accidentally pair a
 * sink from one Stack with a source from another, which would pass on a fresh database
 * and fail only once two Stacks held data.
 *
 * @param harness - Stack to write into and read from.
 * @param written - The store to persist through the sink.
 * @returns The load outcome.
 */
async function sinkThenLoad(
  harness: KgPostgresHarness,
  written: Parameters<ReturnType<typeof databaseEmbeddingLocation>["sink"]["write"]>[0],
): Promise<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>> {
  await seedPages(harness, ["concepts/alpha"]);
  const location = databaseEmbeddingLocation(harness.db, harness.stackId);
  await location.sink.write(written);
  return loadEmbeddingsForSearch("", location.source);
}

describe.skipIf(!harnessReachable)("the loader reads its store through the database seam", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = (await provisionStack("seam")).harness;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("gates a store that only exists in the database", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, {
      version: 3,
      model: resolveEmbeddingModel(),
      dimensions: 768,
      entries: [pageEntry("concepts/alpha", 0.5)],
    });

    const outcome = await loadEmbeddingsForSearch("", databaseEmbeddingSource(harness.db, harness.stackId));

    // The store came from rows, not a file, and passed the same gate the file path
    // uses: same version check, same integrity check, same configuration check.
    expect(outcome.store?.entries).toHaveLength(1);
    expect(outcome.store?.entries[0]?.pageId).toBe("concepts/alpha");
    expect(outcome.warnings).toEqual([]);
  });

  it("reports absence, not a fault, for a Stack that was never embedded", async () => {
    // A fresh Stack must degrade like a project with no store yet -- a reason to
    // build -- rather than warn about a store that is missing.
    await expectOutdatedStore(harness);
  });

  it("degrades a store whose configuration does not match the active model", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    await writeEmbeddingStoreToDb(harness.db, harness.stackId, {
      version: 3,
      model: "some-other-model",
      dimensions: 768,
      entries: [pageEntry("concepts/alpha", 0.5)],
    });

    await expectOutdatedStore(harness);
  });
});

describe.skipIf(!harnessReachable)("the writer persists through the database seam", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = (await provisionStack("sink")).harness;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("writes a store the reader can then read back", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    const sink = databaseEmbeddingSink(harness.db, harness.stackId);

    await sink.write(store([pageEntry("concepts/alpha", 0.4)]));
    const read = await readEmbeddingStoreFromDb(harness.db, harness.stackId);

    expect(read?.entries).toHaveLength(1);
    expect(read?.entries[0]?.pageId).toBe("concepts/alpha");
  });

  it("refuses a v1/v2 store instead of guessing a v3 shape for it", async () => {
    const sink = databaseEmbeddingSink(harness.db, harness.stackId);
    const legacy = { version: 2, model: "m", dimensions: 2, entries: [], chunks: [] } as unknown as EmbeddingStoreV3;

    // Coercing a v2 record into a row would have to guess which page its bare slug
    // addressed -- the exact re-keying that attaches vectors to the wrong page.
    await expect(sink.write(legacy)).rejects.toThrow(/refusing to persist a v2/);
  });

  it("routes a full read-modify-write through the database, not the file", async () => {
    await seedPages(harness, ["concepts/alpha"]);
    // Written with the ACTIVE model on purpose: the gate rejects a store built by a
    // different configuration, and the point here is the location, not the gate.
    await databaseEmbeddingSink(harness.db, harness.stackId).write({
      ...store([pageEntry("concepts/alpha", 0.7)]),
      model: resolveEmbeddingModel(),
    });

    const outcome = await loadEmbeddingsForSearch("", databaseEmbeddingSource(harness.db, harness.stackId));

    // Both halves resolved the same location, so what was written is what is read.
    expect(outcome.store?.entries.map((e) => e.pageId)).toEqual(["concepts/alpha"]);
  });
});

describe("the adapter pairs both directions", () => {
  // The compile's choice of destination is one line, but the dangerous failure is
  // not "rows instead of file" -- it is a read-modify-write that resolves the two
  // halves independently and ends up reading one store while writing another.
  it("returns a source and a sink together", async () => {
    const harness = await createKgPostgresHarness(`loc-${randomUUID().slice(0, 8)}`);
    try {
      const location = databaseEmbeddingLocation(harness.db, harness.stackId);

      expect(typeof location.source.read).toBe("function");
      expect(typeof location.sink.write).toBe("function");
    } finally {
      await harness.cleanup();
    }
  });

  it("reads back exactly what the paired sink wrote", async () => {
    const harness = await createKgPostgresHarness(`roundtrip-${randomUUID().slice(0, 8)}`);
    try {
      // Both halves point at the same Stack, so the write is what the read sees.
      const outcome = await sinkThenLoad(harness, {
        ...store([pageEntry("concepts/alpha", 0.6)]), model: resolveEmbeddingModel(),
      });
      expect(outcome.store?.entries.map((e) => e.pageId)).toEqual(["concepts/alpha"]);
    } finally {
      await harness.cleanup();
    }
  });
});

describe.skipIf(!harnessReachable)("eval stats read where the writer wrote", () => {
  it("counts vectors that live only in the database", async () => {
    const harness = await createKgPostgresHarness(`stats-${randomUUID().slice(0, 8)}`);
    try {
      await seedPages(harness, ["concepts/alpha"]);
      const location = databaseEmbeddingLocation(harness.db, harness.stackId);
      await location.sink.write({
        ...store([pageEntry("concepts/alpha", 0.5)], [chunkEntry("concepts/alpha", 0, 0.5)]),
      });

      const root = await mkdtemp(path.join(tmpdir(), "stats-root-"));
      // Measured before the fix: a fully embedded corpus reported
      // `embeddingsAvailable: false` because stats read only the file.
      const stats = await collectStats(root, location.source);

      // `embeddingsAvailable: false` is only EMITTED on degrade -- its absence is
      // what a healthy snapshot looks like, so asserting `true` would always fail.
      expect(stats).not.toHaveProperty("embeddingsAvailable");
      expect(stats.embeddingCount).toBe(1);
      expect(stats.chunkEmbeddingCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });
});
