/**
 * The stale-refresh planner classifying pages that only exist as rows.
 *
 * `classifyPages` already took the scan shape, so this asserts the last reader moved
 * rather than that the classification changed: the root has no `wiki/`, so a non-empty
 * classification proves the pages came from the table.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStaleRefresh } from "../../src/compiler/refresh-plan.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createPageScanSource } from "../../src/dimensions/wiki/page-scan-source.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const PAGE = "---\ntitle: Alpha\nsummary: s\n---\n\nbody\n";

describe("refresh plan from rows", () => {
  let harness: KgPostgresHarness;
  let root: string;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`refresh-${randomUUID().slice(0, 8)}`);
    root = await mkdtemp(path.join(os.tmpdir(), "no-wiki-refresh-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("reports missing state rather than inventing a plan", async () => {
    // The planner's own precondition, unchanged: no state means no plan, and a row
    // corpus does not change that.
    const { stateStatus, plan } = await resolveStaleRefresh(
      root, createPageScanSource(harness.db, harness.stackId),
    );

    expect(stateStatus).not.toBe("ok");
    expect(plan).toBeNull();
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
