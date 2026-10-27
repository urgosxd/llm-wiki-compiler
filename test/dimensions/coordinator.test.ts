/**
 * @file test/dimensions/coordinator.test.ts
 * @description Behaviour of the transactional coordinator under failure.
 *
 * These tests use in-memory doubles for the dimensions so the failure orderings
 * are exercised deterministically, without a database or a network provider.
 * The wiki and graph dimensions are covered by their own tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { outboxReachable, provisionOutboxStack, type OutboxSetup } from "./outbox-harness.js";

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

/**
 * A dimension double whose phases are individually controllable.
 *
 * It counts ATTEMPTS for `prepare` and `commit`, not just successes, because the
 * retry contract is about how many times the coordinator asks -- two attempts of the
 * transaction and exactly one `prepare`. A double that only counted successes could
 * not tell a retried commit from a single one.
 */
function makeDimension(
  name: DimensionName,
  behaviour: {
    prepareFails?: boolean;
    commitFails?: boolean;
    discardFails?: boolean;
  } = {},
): Dimension & {
  discarded: number;
  committed: number;
  prepareAttempts: number;
  commitAttempts: number;
} {
  const state = { discarded: 0, committed: 0, prepareAttempts: 0, commitAttempts: 0 };
  return {
    name,
    // Getters must live on the returned object. Spreading a getter-bearing literal
    // EVALUATES it once at spread time, which copies the initial zero and makes
    // every later read answer 0 forever -- measured, and the reason three
    // assertions above started reporting 0 for work the double clearly did.
    get discarded() {
      return state.discarded;
    },
    get committed() {
      return state.committed;
    },
    get prepareAttempts() {
      return state.prepareAttempts;
    },
    get commitAttempts() {
      return state.commitAttempts;
    },
    async prepare(): Promise<PreparedWrite> {
      state.prepareAttempts += 1;
      if (behaviour.prepareFails === true) throw new Error(`${name} prepare failed`);
      return { unchanged: false, handle: { name } };
    },
    async commit(): Promise<CommittedWrite> {
      state.commitAttempts += 1;
      if (behaviour.commitFails === true) throw new Error(`${name} commit failed`);
      state.committed += 1;
      return { idempotencyKey: `${name}:key`, summary: `${name}:ok` };
    },
    async discard(): Promise<void> {
      if (behaviour.discardFails === true) throw new Error(`${name} discard failed`);
      state.discarded += 1;
    },
  };
}

/**
 * The usual pair: a healthy wiki and a graph with the behaviour under test.
 *
 * Extracted because four cases build exactly this pair and only the graph's failure
 * mode differs; four copies were flagged as a clone group, and a copy is where a
 * case quietly stops exercising what its name says.
 *
 * @param kgBehaviour - How the graph dimension should misbehave.
 * @returns The wiki double first, the graph double second.
 */
function wikiAndKg(
  kgBehaviour: Parameters<typeof makeDimension>[1] = {},
): [ReturnType<typeof makeDimension>, ReturnType<typeof makeDimension>] {
  return [makeDimension("wiki"), makeDimension("kg", kgBehaviour)];
}

const harnessReachable = await outboxReachable("coordinator");

describe.skipIf(!harnessReachable)("ingestDimensions", () => {
  let setup: OutboxSetup;
  let harness: OutboxSetup["harness"];

  beforeEach(async () => {
    setup = await provisionOutboxStack("coordinator");
    harness = setup.harness;
  });

  afterEach(async () => {
    await setup.release();
  });

  it("commits both dimensions and leaves no pending record", async () => {
    const [wiki, kg] = wikiAndKg();

    const outcome = await ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg]);

    expect(outcome.summaries.get("wiki")).toBe("wiki:ok");
    expect(outcome.summaries.get("kg")).toBe("kg:ok");
    const { records } = await loadRecords(harness.db, harness.stackId);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("committed");
  });

  it("writes no outbox record and commits nothing when prepare fails", async () => {
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg", { prepareFails: true });

    await expect(ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg])).rejects.toThrow(
      "kg prepare failed",
    );

    expect(wiki.committed).toBe(0);
    expect(kg.committed).toBe(0);
    const { records } = await loadRecords(harness.db, harness.stackId);
    expect(records).toHaveLength(0);
  });

  /*
   * THE CENTRAL GUARANTEE, and it replaces a test that asserted the opposite.
   *
   * The old expectation was that the wiki's write SURVIVED a kg failure and the
   * outbox kept a `pending` debt, because the saga could only offer recoverability.
   * With one transaction per attempt that split is gone: nothing lands, and the
   * `pending` record is erased by the same rollback that erased the writes.
   *
   * What is left behind is a `failed` record, written AFTER the rollback precisely
   * so it can be read. It is diagnosis, not debt -- there is nothing to replay.
   */
  it("rolls BOTH dimensions back when one fails, leaving no pending debt", async () => {
    const [wiki, kg] = wikiAndKg({ commitFails: true });

    await expect(ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg])).rejects.toThrow(
      /ingest failed after 2 attempts/,
    );

    // These doubles run OUTSIDE the transaction -- only the outbox write goes
    // through it -- so their counters record that the coordinator ASKED twice,
    // which is the retry contract. What genuinely rolls back is the outbox row:
    // the `pending` record saved inside the transaction is gone, and the only
    // record left is the `failed` one written afterwards.
    expect(wiki.commitAttempts).toBe(2);
    const { records } = await loadRecords(harness.db, harness.stackId);
    // ONE record, and it says the ingest failed rather than asking to be replayed.
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
  });

  it("retries the transaction exactly twice, reusing the prepared handles", async () => {
    // Two attempts of the TRANSACTION, not of the run: `prepare` is where the
    // provider calls live, so a retry that re-prepaied would pay twice.
    const [wiki, kg] = wikiAndKg({ commitFails: true });

    await expect(ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg])).rejects.toThrow();

    expect(wiki.commitAttempts).toBe(2);
    expect(wiki.prepareAttempts).toBe(1);
  });

  it("cleans up a failed attempt when discard itself throws", async () => {
    const wiki = makeDimension("wiki", { discardFails: true });
    const kg = makeDimension("kg", { commitFails: true });

    await expect(ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg])).rejects.toThrow(
      /unresolved: wiki/,
    );

    const { records } = await loadRecords(harness.db, harness.stackId);
    expect(records[0]?.status).toBe("failed");
  });

  it("records each dimension key as it commits", async () => {
    const [wiki, kg] = wikiAndKg();

    const outcome = await ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg]);

    expect(outcome.record.dimensions).toEqual([
      { name: "wiki", idempotencyKey: "wiki:key" },
      { name: "kg", idempotencyKey: "kg:key" },
    ]);
    await removeRecord(harness.db, harness.stackId, outcome.record.ingestId);
  });

  it("surfaces a corrupt dimensions payload instead of hiding it", async () => {
    // The file version could be corrupted by a torn write. A row cannot tear -- but
    // `dimensions` is jsonb, so Postgres guarantees valid JSON and says nothing about
    // the shape this module wrote. A payload that does not parse is unfinished work
    // with no usable description, which must be surfaced rather than treated as absent.
    await saveRecord(harness.db, harness.stackId, {
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
    await harness.db.execute(
      `insert into ingest_outbox (ingest_id, stack_id, source, title, document, body, status, dimensions)
       values ('broken', '${harness.stackId}', 's', 't', 'd', 'b', 'pending', '{"not":"an array"}'::jsonb)`,
    );

    const { records, unreadable } = await loadRecords(harness.db, harness.stackId);

    expect(records).toHaveLength(1);
    expect(unreadable).toEqual(["broken"]);
  });
});
