/**
 * @file test/dimensions/page-delete-rows.test.ts
 * @description A `delete` page mutation must reach the ROW when pages are rows.
 *
 * The file path had a delete: unlink the target under the lock, journalled so a
 * crash can restore it. When the row sink landed, the write path was taught about it
 * and the DELETE path was not, so a `delete` in a Stack-backed project unlinked a
 * file that does not exist and left the row alive — a complete no-op that reported
 * success. The file branch is asserted too, because the fix must not have changed it.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyApprovedMutationsLocked } from "../../src/trust/executor.js";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { createPageRemoveSink, createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const BODY = "---\ntitle: Doomed\n---\n\nbody\n";

/** One `delete` of `concepts/doomed`, the shape the planner produces for a delete. */
const DELETE_MUTATION = {
  kind: "page",
  operation: "delete",
  target: { directory: "concepts", slug: "doomed" },
  body: "",
  provenance: { origin: "compile" },
} as const;

describe("deleting a page whose store is rows", () => {
  let root: string;
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "del-rows-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    harness = await createKgPostgresHarness(`del-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  });

  it("removes the row, with no file on disk to begin with", async () => {
    const sink = createPageWriteSink(harness.db, harness.stackId);
    await sink({ directory: "concepts", slug: "doomed", body: BODY });
    expect(await getStoredPage(harness.db, harness.stackId, "concepts", "doomed")).toBeDefined();

    await applyApprovedMutationsLocked(root, [DELETE_MUTATION] as never, {
      pageSink: sink,
      pageRemover: createPageRemoveSink(harness.db, harness.stackId),
    });

    expect(await getStoredPage(harness.db, harness.stackId, "concepts", "doomed")).toBeUndefined();
  });

  it("still removes the FILE when no remover is supplied", async () => {
    const { writeFile } = await import("node:fs/promises");
    const target = path.join(root, "wiki/concepts/doomed.md");
    await writeFile(target, BODY);

    await applyApprovedMutationsLocked(root, [DELETE_MUTATION] as never);

    // `readFile` rejecting is the assertion: the file is gone.
    await expect(readFile(target, "utf-8")).rejects.toThrow();
  });
});
