/**
 * The raw collector reading pages from rows.
 *
 * `RawWikiPage` is the third shape the seam carries: export and viewer filter on its
 * `parseStatus` flags, so those flags have to be honest for a row -- not merely
 * present. The root has no `wiki/`, so a passing collect proves the rows answered.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRawPageSource } from "../../src/dimensions/wiki/page-scan-source.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

describe("raw page source", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`raw-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-raw-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("collects concepts before queries, as the disk scan does", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "queries", slug: "q", body: "---\ntitle: Q\n---\n\nq\n" });
    await sink({ directory: "concepts", slug: "c", body: "---\ntitle: C\n---\n\nc\n" });

    const pages = await createRawPageSource(harness.db, harness.stackId, root).collect();

    expect(pages.map((p) => p.pageDirectory)).toEqual(["concepts", "queries"]);
  });

  it("reports honest parse flags for a row", async () => {
    // A row cannot exist without valid metadata, so these are the only truthful
    // values -- and the collectors filter on them.
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "c", body: "---\ntitle: C\n---\n\nc\n",
    });

    const [page] = await createRawPageSource(harness.db, harness.stackId, root).collect();

    expect(page?.parseStatus).toEqual({
      hasFrontmatterBlock: true,
      malformedFrontmatter: false,
      hasTitle: true,
      orphaned: false,
    });
    expect(page?.body).toBe("\nc\n");
  });

  it("marks an orphaned row as orphaned, matching the file flag", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "gone", body: "---\ntitle: Gone\norphaned: true\n---\n\nx\n",
    });

    const [page] = await createRawPageSource(harness.db, harness.stackId, root).collect();

    expect(page?.parseStatus.orphaned).toBe(true);
  });
});
