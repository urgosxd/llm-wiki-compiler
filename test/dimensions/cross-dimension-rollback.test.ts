/**
 * @file test/dimensions/cross-dimension-rollback.test.ts
 * @description What actually happens to the wiki when a LATER dimension fails,
 * now that both dimensions share one transaction.
 *
 * ## THIS SUITE HAS CHANGED ITS SUBJECT THREE TIMES, AND THAT IS THE POINT
 *
 * 1. **Originally** it asserted the good property: a `kg` commit failure left
 *    `sources/` empty, because the wiki write was rolled back. That held while the
 *    wiki was file-backed and its `discard` replayed a journal.
 * 2. **Then** the wiki moved to Postgres, where `discard` is deliberately empty.
 *    The suite was inverted to record the loss: the wiki row SURVIVED, the outbox
 *    kept a `pending` debt, and the guarantee was recoverability rather than
 *    atomicity.
 * 3. **Then** (dimension port v3) the coordinator ran both dimensions in ONE
 *    transaction, retried twice. The saga was gone, so the loss recorded in (2) was
 *    gone with it, and this suite went back to asserting the property that was
 *    originally wanted -- because the transaction provides it, not because a local
 *    file could be reverted.
 * 4. **Now** one assertion was corrected: it claimed "no source markdown was
 *    written" by checking for a `sources/` directory inside a `mkdtemp` root that no
 *    dimension in this file is ever given. Probed, that directory enters and exits
 *    the run empty, so the case passed without inspecting anything. The projection
 *    claim moved to where a real root exists (`wiki-store-dimension.test.ts` and
 *    `source-projection.test.ts`); what stays here is the claim these doubles can
 *    actually prove.
 *
 * Each inversion was a measurement of the code, never an adjustment to make a red
 * test green. The comments stay because a reader who finds only the final
 * assertion cannot tell whether it was ever wrong.
 *
 * ## What this suite can and cannot prove
 *
 * The doubles below run OUTSIDE the transaction: only the outbox write goes
 * through it. So this file proves the COORDINATOR'S BOOKKEEPING -- two attempts,
 * the pending record erased by the rollback, a `failed` record written after it.
 *
 * It does NOT prove that Postgres rolls back a dimension's rows. That is measured
 * where it belongs, against the real database:
 * `kg-runtime-cross-dimension-transaction.test.ts` for feasibility, and
 * `ingest-atomicity.test.ts` for the shipped wiki and graph dimensions committing
 * and rolling back together.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import { loadRecords } from "../../src/dimensions/outbox.js";
import { reconcileOutbox } from "../../src/dimensions/reconcile.js";
import type { Dimension } from "../../src/dimensions/types.js";

/** One document, as an ingest would hand it to the coordinator. */
const INPUT = { source: "https://example.test/a", title: "A", document: "# A\nbody", body: "body" };

/**
 * A fresh Stack for the outbox.
 *
 * Records are rows now and belong to a Stack, so each case gets its own harness:
 * the outbox is tenanted, and a shared Stack would let one case see another's
 * pending work.
 */
async function newHarness(): Promise<KgPostgresHarness> {
  return createKgPostgresHarness(`dim-rollback-${randomUUID().slice(0, 8)}`);
}

/**
 * A dimension that records what the coordinator asked of it.
 *
 * Counting ATTEMPTS rather than successes is deliberate: the retry contract is
 * about how many times the coordinator asks, and a double that only counted
 * successes could not tell a retried commit from a single one.
 */
function recordingDimension(
  name: "wiki" | "kg",
  events: string[],
  behaviour: { failCommit?: boolean; failPrepare?: boolean; projections?: string[] } = {},
): Dimension {
  return {
    name,
    prepare: async () => {
      events.push(`${name}:prepare`);
      if (behaviour.failPrepare === true) throw new Error(`${name} prepare exploded`);
      return { unchanged: false, handle: {} };
    },
    commit: async () => {
      events.push(`${name}:commit`);
      if (behaviour.failCommit === true) throw new Error(`${name} commit exploded`);
      return {
        idempotencyKey: `${name}:key`,
        summary: `${name}:created`,
        // A projection is only ever reached for a commit that REPORTED success, so
        // logging it is what makes "no projection ran" an observation rather than
        // an assumption about a directory nobody looked at.
        afterCommit: async () => {
          behaviour.projections?.push(name);
        },
      };
    },
    discard: async () => {
      events.push(`${name}:discard`);
    },
  };
}

/**
 * The failing pair this suite is about: a healthy wiki and a graph that explodes on
 * commit, sharing one event log so the ORDER can be asserted.
 *
 * Extracted because the fixture and the "expect it to fail" call were identical in
 * two cases, and a copy is where one case quietly starts failing for a different
 * reason than the one its name states.
 *
 * @param events - Log the doubles append to.
 * @param projections - Log of `afterCommit` invocations, by dimension name.
 * @returns The harness the run used, and the promise it rejects with.
 */
async function runUntilKgFails(events: string[], projections: string[]): Promise<{
  harness: KgPostgresHarness;
  failure: Promise<unknown>;
}> {
  const harness = await newHarness();
  const failure = ingestDimensions(harness.db, harness.stackId, INPUT, [
    recordingDimension("wiki", events, { projections }),
    recordingDimension("kg", events, { failCommit: true, projections }),
  ]);
  return { harness, failure };
}

/** What one failed ingest left behind, which is what every case here inspects. */
async function ingestUntilKgFails(): Promise<{
  readonly records: Awaited<ReturnType<typeof loadRecords>>;
  readonly events: string[];
  readonly root: string;
  readonly harness: KgPostgresHarness;
  readonly projections: string[];
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dim-rollback-")));
  const events: string[] = [];
  const projections: string[] = [];
  const { harness, failure } = await runUntilKgFails(events, projections);

  await expect(failure).rejects.toThrow(/ingest failed after 2 attempts/);

  return { records: await loadRecords(harness.db, harness.stackId), events, root, harness, projections };
}

describe("cross-dimension failure under one transaction", () => {
  it("leaves NO pending debt, because the rollback erased the pending record", async () => {
    const outcome = await ingestUntilKgFails();
    // The `pending` row was saved INSIDE the transaction, so it rolled back with
    // the dimension writes. That is the whole difference from the saga: there is
    // no record asking to be replayed.
    expect(outcome.records.records.some((record) => record.status === "pending")).toBe(false);
  });

  it("keeps exactly one record, and it says the ingest failed", async () => {
    const outcome = await ingestUntilKgFails();
    expect(outcome.records.unreadable).toHaveLength(0);
    expect(outcome.records.records).toHaveLength(1);
    expect(outcome.records.records[0]?.status).toBe("failed");
  });

  it("never runs a projection, because no dimension committed", async () => {
    const outcome = await ingestUntilKgFails();
    // THIS REPLACES A VACUOUS ASSERTION. The old case checked
    // `existsSync(path.join(outcome.root, "sources"))` on a `mkdtemp` directory the
    // doubles are never handed, so it passed no matter what the projection did.
    //
    // What these doubles CAN prove is the precondition the file-level guarantee
    // rests on: a projection only runs for a dimension whose `commit` reported
    // success, and here none did. Zero `afterCommit` calls is why no source markdown
    // can exist -- and it is observable, unlike an empty directory.
    //
    // The file-level claim itself is covered where a real root is passed:
    // `wiki-store-dimension.test.ts` ("actually writes the markdown under
    // sources/") and `source-projection.test.ts` (compensation).
    expect(outcome.projections).toEqual([]);
    // And the negative control: the root really is empty, so a future reader cannot
    // mistake an empty directory for a fulfilled guarantee.
    expect(existsSync(path.join(outcome.root, "sources"))).toBe(false);
  });

  it("does NOT replay a failed record, because nothing landed", async () => {
    const outcome = await ingestUntilKgFails();
    // Reconciled against the SAME Stack the failure left behind, using dimensions
    // that WOULD succeed -- so "it did not replay" is a real observation rather
    // than a consequence of the doubles still being broken.
    const reconciled = await reconcileOutbox(outcome.harness.db, outcome.harness.stackId, [
      recordingDimension("wiki", []),
      recordingDimension("kg", []),
    ]);
    // Reported, never retried: replaying would commit work the caller was told had
    // failed, possibly after they already fixed the cause and re-ingested.
    expect(reconciled.failed).toHaveLength(1);
    expect(reconciled.finished).toHaveLength(0);
  });
});

describe("the lifecycle the coordinator actually invokes", () => {
  it("asks EVERY prepared dimension to discard after the run fails", async () => {
    // `discard` filters on `run.prepared !== null`, NOT on `run.committed !== null`.
    // That is correct now for a reason the saga version did not have: inside one
    // transaction nothing is visible to undo, so `discard` only covers a dimension
    // whose `prepare` allocated something OUTSIDE the transaction.
    const harness = await newHarness();
    const events: string[] = [];

    await expect(
      ingestDimensions(harness.db, harness.stackId, INPUT, [
        recordingDimension("wiki", events),
        recordingDimension("kg", events, { failPrepare: true }),
      ]),
    ).rejects.toThrow("kg prepare exploded");

    expect(events).toEqual(["wiki:prepare", "kg:prepare", "wiki:discard"]);
    const { records } = await loadRecords(harness.db, harness.stackId);
    // No record at all: `prepare` failed before any transaction opened, so no
    // `pending` row was ever written and no `failed` row is warranted.
    expect(records).toHaveLength(0);
  });

  it("does NOT ask a dimension that never prepared to discard", async () => {
    const harness = await newHarness();
    const events: string[] = [];

    await expect(
      ingestDimensions(harness.db, harness.stackId, INPUT, [
        recordingDimension("wiki", events, { failPrepare: true }),
      ]),
    ).rejects.toThrow("wiki prepare exploded");

    expect(events).toEqual(["wiki:prepare"]);
  });

  it("retries the transaction body twice and prepares only once", async () => {
    // The retry contract, stated as the code behaves: prepare runs once because it
    // holds the provider calls, and the transaction is attempted twice because a
    // rollback leaves nothing to clean up before trying again.
    const events: string[] = [];
    const { failure } = await runUntilKgFails(events);

    await expect(failure).rejects.toThrow("kg commit exploded");

    expect(events.filter((entry) => entry === "wiki:prepare")).toHaveLength(1);
    expect(events.filter((entry) => entry === "kg:prepare")).toHaveLength(1);
    // Two full attempts: each runs wiki's commit before kg's failure.
    expect(events.filter((entry) => entry === "wiki:commit")).toHaveLength(2);
    expect(events.filter((entry) => entry === "kg:commit")).toHaveLength(2);
  });
});
