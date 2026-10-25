/**
 * The embedding collector reading pages from rows.
 *
 * This is the one that fails SILENTLY: an empty collection computes no vectors and
 * stores none, so semantic search returns nothing while every step reports success.
 * The root has no `wiki/`, so a non-empty collection proves the rows answered.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddingPageSource } from "../../src/dimensions/wiki/page-scan-source.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const ALPHA = "---\ntitle: Alpha\nsummary: s\n---\n\nbody\n";

describe("embedding page source", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`emb-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-emb-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("collects a row-backed page with the fields embedding needs", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });

    const [collected] = await createEmbeddingPageSource(harness.db, harness.stackId).collectNamespaced();

    expect(collected?.namespace).toBe("concepts");
    expect(collected?.record.title).toBe("Alpha");
    expect(collected?.record.summary).toBe("s");
    expect(collected?.record.body).toBe("body");
  });

  it("EXCLUDES an orphaned page, as the disk reader does", async () => {
    // `readConfinedPageRecord` returns null for an orphaned page. Embedding one here
    // would compute a vector the next disk-backed run considers gone.
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "gone", body: "---\ntitle: Gone\norphaned: true\n---\n\nx\n",
    });

    expect(await createEmbeddingPageSource(harness.db, harness.stackId).collectNamespaced()).toEqual([]);
  });

  it("answers existence by qualified page id", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });
    const source = createEmbeddingPageSource(harness.db, harness.stackId);

    expect(await source.exists("concepts/alpha")).toBe("present");
    expect(await source.exists("concepts/missing")).toBe("absent");
    expect(await source.exists("nonsense")).toBe("unknown");
  });
});
