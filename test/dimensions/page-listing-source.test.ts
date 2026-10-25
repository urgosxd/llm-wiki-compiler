/**
 * The row-backed listing source, read through the public `listPages` API.
 *
 * This is the join the migration needed: pages written as rows by compile must be
 * the pages `listPages` returns. Asserting only the store would prove the row
 * exists, not that a consumer sees it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPages } from "../../src/pages/list.js";
import { createPageWriteSink, createPageListingSource } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const RENDERED = "---\ntitle: Vector DB\nsummary: s\ntags:\n  - search\n---\n\nBody [[embeddings]].\n";

describe("row-backed listing", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`listing-${randomUUID().slice(0, 8)}`);
    // A root with NO wiki/ directory at all: if the listing answers, it answered
    // from rows and could not have scanned a directory that does not exist.
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("lists a compiled page from rows alone", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "vector-db", body: RENDERED,
    });
    const source = createPageListingSource(harness.db, harness.stackId);

    const listing = await listPages(root, { pageSource: source });

    expect(listing.pages.map((p) => p.slug)).toEqual(["vector-db"]);
    expect(listing.pages[0]?.title).toBe("Vector DB");
    expect(listing.pages[0]?.tags).toEqual(["search"]);
  });
});
