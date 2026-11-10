/**
 * The page scan reading pages that only exist as rows.
 *
 * The scan already took the scan shape, so this asserts the last reader moved rather
 * than that the classification changed: the root has no `wiki/`, so a non-empty
 * scan proves the pages came from the table.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { createPageScanSource } from "../../packages/wiki/src/dimensions/wiki/page-scan-source.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { provisionStack } from "../fixtures/stack-harness.js";

const PAGE = "---\ntitle: Alpha\nsummary: s\n---\n\nbody\n";

describe("refresh plan from rows", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = (await provisionStack("refresh")).harness;
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-refresh-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("sees the row-backed page, so classification is not empty", async () => {
    await createPageWriteSink(harness.db, harness.stackId)({
      directory: "concepts", slug: "alpha", body: PAGE,
    });
    const scan = createPageScanSource(harness.db, harness.stackId);

    // The scan itself is what the planner consumes. Its `meta` carries the status
    // flags as explicit booleans, while the disk scan omits an absent key entirely --
    // equivalent here because every consumer tests them for truthiness
    // (`meta.orphaned === true`, `!meta.orphaned`), never for key presence.
    const [page] = await scan.scan("concepts");
    expect(page?.slug).toBe("alpha");
    expect(page?.meta.title).toBe("Alpha");
    expect(page?.meta.orphaned).toBe(false);
  });
});
