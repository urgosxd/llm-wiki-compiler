/**
 * `collectStatus` reading page counts from rows.
 *
 * The root has NO `wiki/` directory, so a passing count proves the pages came from
 * the table. The scan shape is shared with the index builder and the refresh
 * planner, so getting this right is what lets the rest of them move.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStatus } from "../../src/status/collect.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createPageScanSource } from "../../src/dimensions/wiki/page-scan-source.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** Render a page the way compile does, frontmatter included. */
function page(title: string, extra = ""): string {
  return `---\ntitle: ${title}\nsummary: s\n${extra}---\n\nbody\n`;
}

describe("status from rows", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`status-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-status-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("counts pages that exist only as rows", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "a", body: page("A") });
    await sink({ directory: "concepts", slug: "b", body: page("B") });

    const status = await collectStatus(root, {
      pageScan: createPageScanSource(harness.db, harness.stackId),
    });

    expect(status.pages.concepts).toBe(2);
    expect(status.pages.total).toBe(2);
  });

  it("excludes an orphaned page from the summary count, as the file scan does", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "live", body: page("Live") });
    await sink({ directory: "concepts", slug: "gone", body: page("Gone", "orphaned: true\n") });

    const status = await collectStatus(root, {
      pageScan: createPageScanSource(harness.db, harness.stackId),
    });

    // collectPageSummaries drops orphaned pages; the scan keeps them. The count must
    // follow the summary rule, not the scan.
    expect(status.pages.concepts).toBe(1);
  });

  it("keeps the on-disk scan when no source is supplied", async () => {
    const status = await collectStatus(root);

    expect(status.pages.total).toBe(0);
  });
});
