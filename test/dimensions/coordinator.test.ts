/**
 * @file test/dimensions/coordinator.test.ts
 * @description Behaviour of the transactional coordinator under failure.
 *
 * These tests use in-memory doubles for the dimensions so the failure orderings
 * are exercised deterministically, without a database or a network provider.
 * The wiki and graph dimensions are covered by their own tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import { loadRecords, removeRecord, saveRecord } from "../../src/dimensions/outbox.js";
import type {
  CommittedWrite,
  Dimension,
  DimensionInput,
  DimensionName,
  PreparedWrite,
} from "../../src/dimensions/types.js";

/** Input shared by every case. */
const INPUT: DimensionInput = {
  source: "https://example.test/a",
  title: "A",
  document: "# A\n\nbody\n",
  body: "body",
};

/** A dimension double whose three phases are individually controllable. */
function makeDimension(
  name: DimensionName,
  behaviour: {
    prepareFails?: boolean;
    commitFails?: boolean;
    discardFails?: boolean;
  } = {},
): Dimension & { discarded: number; committed: number } {
  const state = { discarded: 0, committed: 0 };
  return {
    name,
    ...state,
    async prepare(): Promise<PreparedWrite> {
      if (behaviour.prepareFails === true) throw new Error(`${name} prepare failed`);
      return { unchanged: false, handle: { name } };
    },
    async commit(): Promise<CommittedWrite> {
      if (behaviour.commitFails === true) throw new Error(`${name} commit failed`);
      state.committed += 1;
      return { idempotencyKey: `${name}:key`, summary: `${name}:ok` };
    },
    async discard(): Promise<void> {
      if (behaviour.discardFails === true) throw new Error(`${name} discard failed`);
      state.discarded += 1;
    },
    get discarded() {
      return state.discarded;
    },
    get committed() {
      return state.committed;
    },
  };
}

describe("ingestDimensions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-dim-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("commits both dimensions and leaves no pending record", async () => {
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg");

    const outcome = await ingestDimensions(root, INPUT, [wiki, kg]);

    expect(outcome.summaries.get("wiki")).toBe("wiki:ok");
    expect(outcome.summaries.get("kg")).toBe("kg:ok");
    const { records } = await loadRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("committed");
  });

  it("writes no outbox record and commits nothing when prepare fails", async () => {
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg", { prepareFails: true });

    await expect(ingestDimensions(root, INPUT, [wiki, kg])).rejects.toThrow(
      "kg prepare failed",
    );

    expect(wiki.committed).toBe(0);
    expect(kg.committed).toBe(0);
    const { records } = await loadRecords(root);
    expect(records).toHaveLength(0);
  });

  /*
   * A COMMITTED dimension keeps its outbox record, and this replaces a test that
   * asserted the opposite.
   *
   * The old expectation was that a clean-looking `discard` proved the rolled-back
   * ingest left nothing to recover, so the record could be deleted. That held only
   * while every dimension reverted for real. `discard` is specified as undoing a
   * PREPARED-BUT-UNCOMMITTED write (see the port in `types.ts`), so it promises
   * nothing once `commit` has landed -- and the database-backed wiki's is a
   * deliberate no-op. Deleting the record then left a visible write with no
   * recovery trail.
   *
   * The record is now kept `pending`, which is what lets `reconcileOutbox` finish
   * the ingest by replaying the idempotent commit.
   */
  it("keeps the pending record when a committed dimension cannot prove it undid", async () => {
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg", { commitFails: true });

    await expect(ingestDimensions(root, INPUT, [wiki, kg])).rejects.toThrow(
      "kg commit failed",
    );

    expect(wiki.committed).toBe(1);
    expect(wiki.discarded).toBe(1);
    const { records } = await loadRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("pending");
  });

  it("keeps the pending record when rollback itself fails", async () => {
    const wiki = makeDimension("wiki", { discardFails: true });
    const kg = makeDimension("kg", { commitFails: true });

    await expect(ingestDimensions(root, INPUT, [wiki, kg])).rejects.toThrow(
      "kg commit failed",
    );

    const { records } = await loadRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("pending");
  });

  it("records each dimension key as it commits", async () => {
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg");

    const outcome = await ingestDimensions(root, INPUT, [wiki, kg]);

    expect(outcome.record.dimensions).toEqual([
      { name: "wiki", idempotencyKey: "wiki:key" },
      { name: "kg", idempotencyKey: "kg:key" },
    ]);
    await removeRecord(root, outcome.record.ingestId);
  });

  it("surfaces an unreadable outbox file instead of hiding it", async () => {
    await saveRecord(root, {
      version: 1,
      ingestId: "ok",
      source: "s",
      title: "t",
      document: "d",
      body: "b",
      status: "committed",
      dimensions: [],
      createdAt: new Date().toISOString(),
    });
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, ".llmwiki/dimensions/outbox"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki/dimensions/outbox/broken.json"), "{");

    const { records, unreadable } = await loadRecords(root);

    expect(records).toHaveLength(1);
    expect(unreadable).toEqual(["broken.json"]);
  });
});
