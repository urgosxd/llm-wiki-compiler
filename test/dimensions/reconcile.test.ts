/**
 * @file test/dimensions/reconcile.test.ts
 * @description Finishing and reporting ingests that an earlier run left pending.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { outboxReachable, provisionOutboxStack, type OutboxSetup } from "./outbox-harness.js";

import { reconcileOutbox } from "../../src/dimensions/reconcile.js";
import { loadRecords, saveRecord, type OutboxRecord } from "../../src/dimensions/outbox.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import type {
  CommittedWrite,
  Dimension,
  DimensionName,
  PreparedWrite,
} from "../../src/dimensions/types.js";

/** A pending record with one dimension already committed. */
async function savePending(
  harness: OutboxSetup["harness"],
  dimensions: OutboxRecord["dimensions"],
): Promise<void> {
  await saveRecord(harness.db, harness.stackId, {
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

const harnessReachable = await outboxReachable("reconcile");

describe.skipIf(!harnessReachable)("reconcileOutbox", () => {
  let setup: OutboxSetup;
  let harness: OutboxSetup["harness"];

  beforeEach(async () => {
    setup = await provisionOutboxStack("reconcile");
    harness = setup.harness;
  });

  afterEach(async () => {
    await setup.release();
  });

  it("finishes a pending record and removes it", async () => {
    await savePending(harness, [
      { name: "wiki", idempotencyKey: "wiki:done" },
      { name: "kg", idempotencyKey: null },
    ]);
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg");

    const outcome = await reconcileOutbox(harness.db, harness.stackId, [wiki, kg]);

    expect(outcome.finished).toEqual(["ingest-1"]);
    expect(wiki.commits).toBe(0);
    expect(kg.commits).toBe(1);
    const { records } = await loadRecords(harness.db, harness.stackId);
    expect(records).toHaveLength(0);
  });

  it("skips a dimension that already recorded a key", async () => {
    await savePending(harness, [
      { name: "wiki", idempotencyKey: "wiki:done" },
      { name: "kg", idempotencyKey: "kg:done" },
    ]);
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg");

    await reconcileOutbox(harness.db, harness.stackId, [wiki, kg]);

    expect(wiki.commits).toBe(0);
    expect(kg.commits).toBe(0);
  });

  it("reports an unresolved record instead of dropping it", async () => {
    await savePending(harness, [{ name: "kg", idempotencyKey: null }]);
    const kg = makeDimension("kg", true);

    const outcome = await reconcileOutbox(harness.db, harness.stackId, [kg]);

    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]?.reason).toContain("unavailable");
    const { records } = await loadRecords(harness.db, harness.stackId);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("pending");
  });

  it("removes a committed record", async () => {
    await saveRecord(harness.db, harness.stackId, {
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

    const outcome = await reconcileOutbox(harness.db, harness.stackId, []);

    expect(outcome.finished).toEqual(["done"]);
    expect((await loadRecords(harness.db, harness.stackId)).records).toHaveLength(0);
  });

  it("surfaces a record whose dimensions payload cannot be trusted", async () => {
    // A row cannot tear the way a file could, but `dimensions` is jsonb: Postgres
    // guarantees valid JSON, not the shape this module wrote. A payload that is not
    // an array of entries is unfinished work with no usable description.
    await harness.db.execute(
      `insert into ingest_outbox (ingest_id, stack_id, source, title, document, body, status, dimensions)
       values ('bad', '${harness.stackId}', 's', 't', 'd', 'b', 'pending', '"not-an-array"'::jsonb)`,
    );

    const outcome = await reconcileOutbox(harness.db, harness.stackId, []);

    expect(outcome.unreadable).toEqual(["bad"]);
  });
});
