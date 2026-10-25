/**
 * The page registry answering from rows instead of `wiki/`.
 *
 * These read the same questions the disk path reads. The adapter takes no root at
 * all, so a passing assertion cannot be the directory having been found: only the
 * rows could have answered. The orphan case is the one that fails silently in
 * production -- an orphaned page is rankable and groundable the moment it slips
 * through, and nothing else in the pipeline reports it.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegistryPageSource } from "../../src/dimensions/wiki/page-registry-source.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { buildNamespaceDirs } from "../../src/utils/page-registry.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { hashChunkText, splitIntoChunks } from "../../src/utils/retrieval.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** A page whose body carries leading whitespace, to pin the trim on the way out. */
const INDENTED = "---\ntitle: Alpha\nsummary: first letter\n---\n\n\n   Indented lead paragraph.\n\nSecond paragraph.\n";

/** Interpret a titled-only page, used where summary is not the subject. */
const PLAIN = "---\ntitle: Beta\n---\n\nbeta body\n";

/** A page the compiler has retired; the disk reader refuses to load one. */
const ORPHAN = "---\ntitle: Gone\norphaned: true\n---\n\ngone body\n";

describe("registry page source", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`reg-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("reports a row-backed page as live", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: INDENTED,
    });

    const ids = await createRegistryPageSource(harness.db, harness.stackId).liveIds(
      ["concepts", "queries"], buildNamespaceDirs(),
    );

    expect([...ids]).toEqual(["concepts/alpha"]);
  });

  it("EXCLUDES an orphaned page from live ids and from records", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "gone", body: ORPHAN });
    await sink({ directory: "concepts", slug: "alpha", body: INDENTED });
    const source = createRegistryPageSource(harness.db, harness.stackId);

    const ids = await source.liveIds(["concepts"], buildNamespaceDirs());
    const records = await source.records(["concepts/gone", "concepts/alpha"]);

    expect(ids.has("concepts/gone")).toBe(false);
    expect(records.map((record) => record.slug)).toEqual(["alpha"]);
  });

  it("returns chunk hashes identical to those from the trimmed body", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: INDENTED,
    });

    const live = await createRegistryPageSource(harness.db, harness.stackId).liveEntry(
      "concepts/alpha", buildNamespaceDirs(),
    );

    // `page.body` is what the parser returned -- untrimmed -- and the disk path hashes
    // `page.body.trim()`. Deriving the expectation the same way proves parity.
    const diskBody = parseFrontmatter(INDENTED).body;
    expect(diskBody).not.toBe(diskBody.trim());
    expect(live?.chunkHashes).toEqual(splitIntoChunks(diskBody.trim()).map(hashChunkText));
    expect(live?.chunkHashes.length).toBeGreaterThan(0);
  });

  it("hashes identically from an untrimmed body, so the trim guards text not hashes", async () => {
    // Measured, not assumed: `splitIntoChunks` trims each paragraph and drops the
    // whitespace-only ones, so body-edge whitespace never reaches a chunk. Asserting
    // this pins WHERE the trim is load-bearing -- a future `splitIntoChunks` change
    // that made hashes trim-sensitive would break here, not silently in the store.
    const body = parseFrontmatter(INDENTED).body;

    expect(splitIntoChunks(body).map(hashChunkText)).toEqual(
      splitIntoChunks(body.trim()).map(hashChunkText),
    );
  });

  it("returns surface candidates carrying title and summary", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: INDENTED,
    });
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "gone", body: ORPHAN,
    });

    const candidates = await createRegistryPageSource(harness.db, harness.stackId).surfaceCandidates(
      "search", ["concepts"], buildNamespaceDirs(),
    );

    expect(candidates).toEqual([
      { pageId: "concepts/alpha", slug: "alpha", title: "Alpha", summary: "first letter" },
    ]);
  });

  it("pairs records with the id each came from", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "queries", slug: "beta", body: PLAIN,
    });

    const pairs = await createRegistryPageSource(harness.db, harness.stackId).recordPairs([
      "queries/beta",
      "queries/missing",
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.pageId).toBe("queries/beta");
    expect(pairs[0]?.record).toEqual({
      slug: "beta", title: "Beta", summary: "", body: "beta body",
    });
  });

  it("serves a body with no trailing blank line to a consumer", async () => {
    // Answer grounding renders `record.body` directly, so the trim the disk reader
    // applies has to survive here too -- otherwise one backend emits a leading
    // blank line and the other does not.
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: INDENTED,
    });

    const [record] = await createRegistryPageSource(harness.db, harness.stackId).records(["concepts/alpha"]);

    expect(record?.body).toBe("Indented lead paragraph.\n\nSecond paragraph.");
    expect(record?.title).toBe("Alpha");
  });
});
