/**
 * @file test/dimensions/reconcile.test.ts
 * @description Finishing and reporting ingests that an earlier run left pending.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { reconcileOutbox } from "../../src/dimensions/reconcile.js";
import { loadRecords, saveRecord, type OutboxRecord } from "../../src/dimensions/outbox.js";
import type {
  CommittedWrite,
  Dimension,
  DimensionName,
  PreparedWrite,
} from "../../src/dimensions/types.js";

/** A pending record with one dimension already committed. */
async function savePending(root: string, dimensions: OutboxRecord["dimensions"]): Promise<void> {
  await saveRecord(root, {
    version: 1,
    ingestId: "ingest-1",
    source: "https://example.test/a",
    title: "A",
    document: "# A\n",
    body: "A",
    status: "pending",
    dimensions,
    createdAt: new Date().toISOString(),
  });
}

/** Dimension double that succeeds unless told otherwise. */
function makeDimension(
  name: DimensionName,
  commitFails = false,
): Dimension & { commits: number } {
  const state = { commits: 0 };
  return {
    name,
    async prepare(): Promise<PreparedWrite> {
      return { unchanged: false, handle: null };
    },
    async commit(): Promise<CommittedWrite> {
      if (commitFails) throw new Error(`${name} unavailable`);
      state.commits += 1;
      return { idempotencyKey: `${name}:key`, summary: name };
    },
    async discard(): Promise<void> {
      return;
    },
    get commits() {
      return state.commits;
    },
  };
}

describe("reconcileOutbox", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-reconcile-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finishes a pending record and removes it", async () => {
    await savePending(root, [
      { name: "wiki", idempotencyKey: "wiki:done" },
      { name: "kg", idempotencyKey: null },
    ]);
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg");

    const outcome = await reconcileOutbox(root, [wiki, kg]);

    expect(outcome.finished).toEqual(["ingest-1"]);
    expect(wiki.commits).toBe(0);
    expect(kg.commits).toBe(1);
    const { records } = await loadRecords(root);
    expect(records).toHaveLength(0);
  });

  it("skips a dimension that already recorded a key", async () => {
    await savePending(root, [
      { name: "wiki", idempotencyKey: "wiki:done" },
      { name: "kg", idempotencyKey: "kg:done" },
    ]);
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg");

    await reconcileOutbox(root, [wiki, kg]);

    expect(wiki.commits).toBe(0);
    expect(kg.commits).toBe(0);
  });

  it("reports an unresolved record instead of dropping it", async () => {
    await savePending(root, [{ name: "kg", idempotencyKey: null }]);
    const kg = makeDimension("kg", true);

    const outcome = await reconcileOutbox(root, [kg]);

    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]?.reason).toContain("unavailable");
    const { records } = await loadRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("pending");
  });

  it("removes a committed record", async () => {
    await saveRecord(root, {
      version: 1,
      ingestId: "done",
      source: "s",
      title: "t",
      document: "d",
      body: "b",
      status: "committed",
      dimensions: [],
      createdAt: new Date().toISOString(),
    });

    const outcome = await reconcileOutbox(root, []);

    expect(outcome.finished).toEqual(["done"]);
    expect((await loadRecords(root)).records).toHaveLength(0);
  });

  it("surfaces an unreadable record file", async () => {
    const dir = path.join(root, ".llmwiki/dimensions/outbox");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "bad.json"), "{not json", "utf-8");

    const outcome = await reconcileOutbox(root, []);

    expect(outcome.unreadable).toEqual(["bad.json"]);
  });
});
