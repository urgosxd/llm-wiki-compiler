/**
 * Compiled pages stored as rows.
 *
 * The property that matters is parity: the same rendered markdown must become the
 * same `Page` whether it lands on disk or in a row. A divergence would show up as a
 * query answering with a stale title or a dropped tag, long after compile.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPageWriteSink, toPage } from "../../src/dimensions/wiki/page-write-sink.js";
import { getStoredPage, listStoredPages } from "../../src/dimensions/wiki/page-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { wikiReachable } from "../fixtures/stack-harness.js";

const RENDERED = `---
title: Vector Databases
summary: Stores that index embeddings.
tags:
  - search
  - storage
---

Vector stores index [[embeddings]] for retrieval.
`;

const request = { directory: "concepts", slug: "vector-db", body: RENDERED };

const harnessReachable = await wikiReachable("sink");

describe.skipIf(!harnessReachable)("page write sink", () => {
  it("stores the parsed page as a row", async () => {
    const harness = await createKgPostgresHarness(`sink-${randomUUID().slice(0, 8)}`);
    try {
      await createPageWriteSink(harness.db, harness.stackId)(request);
      const [stored] = await listStoredPages(harness.db, harness.stackId, 10);

      expect(stored?.slug).toBe("vector-db");
      expect(stored?.title).toBe("Vector Databases");
      expect(stored?.tags).toEqual(["search", "storage"]);
      // Body is NOT part of the listing projection, so it is read back through the
      // single-page reader -- asserting it here would have been asserting that the
      // listing returns a column it deliberately omits.
      const full = await getStoredPage(harness.db, harness.stackId, "concepts", "vector-db");
      expect(full?.body).toContain("[[embeddings]]");
    } finally {
      await harness.cleanup();
    }
  });

  it("parses exactly what the file path would, links included", () => {
    // Links come from the BODY, not from frontmatter, so this is where a
    // re-implementation would most easily drift.
    expect(toPage(request).links).toEqual(["embeddings"]);
  });

  it("upserts rather than duplicating on a second write", async () => {
    const harness = await createKgPostgresHarness(`sink2-${randomUUID().slice(0, 8)}`);
    try {
      const sink = createPageWriteSink(harness.db, harness.stackId);
      await sink(request);
      await sink({ ...request, body: RENDERED.replace("Vector Databases", "Renamed") });
      const stored = await listStoredPages(harness.db, harness.stackId, 10);

      expect(stored).toHaveLength(1);
      expect(stored[0]?.title).toBe("Renamed");
    } finally {
      await harness.cleanup();
    }
  });
});
