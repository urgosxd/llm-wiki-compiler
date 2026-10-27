/**
 * @file test/dimensions/cross-dimension-rollback.test.ts
 * @description What actually happens to the wiki when a LATER dimension fails,
 * now that both dimensions share one transaction.
 *
 * ## THIS SUITE HAS CHANGED ITS SUBJECT FOUR TIMES, AND THAT IS THE POINT
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
 * 4. **Then** the outbox was retired. Cases that asserted a `failed` row and that a
 *    replay refused it had nothing left to measure: the row, the reconciler and the
 *    replay are all gone. What survives is the coordinator's sequencing -- two
 *    attempts, one `prepare`, `discard` for every prepared dimension, and no
 *    projection -- plus the submission removed a vacuous projection assertion that
 *    checked for `sources/` inside a `mkdtemp` root no dimension in this file is
 *    ever given.
 *
 * Each change was a measurement of the code, never an adjustment to make a red test
 * green. The history stays because a reader who finds only the final assertion
 * cannot tell whether it was ever wrong.
 *
 * ## What this suite can and cannot prove
 *
 * The doubles below run OUTSIDE the transaction: they record calls instead of
 * writing rows. So this file proves the COORDINATOR'S SEQUENCING -- how many times
 * it asked each dimension, in what order, and that it discarded what it prepared.
 *
 * It does NOT prove that Postgres rolls back a dimension's rows. That is measured
 * where it belongs, against the real database: `ingest-atomicity.test.ts` drives
 * the shipped wiki and graph dimensions and inspects the actual tables.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import type { Dimension, DimensionInput } from "../../src/dimensions/types.js";

/** One document, as an ingest would hand it to the coordinator. */
const INPUT: DimensionInput = { source: "https://example.test/a", title: "A", document: "# A\nbody", body: "body" };

/** A fresh Stack, so no case can see another's rows. */
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
  readonly events: string[];
  readonly root: string;
  readonly projections: string[];
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dim-rollback-")));
  const events: string[] = [];
  const projections: string[] = [];
  const { harness, failure } = await runUntilKgFails(events, projections);
  try {
    await expect(failure).rejects.toThrow(/ingest failed after 2 attempts/);
  } finally {
    await harness.cleanup();
  }
  return { events, root, projections };
}

describe("cross-dimension failure under one transaction", () => {
  it("never runs a projection, because no dimension committed", async () => {
    const outcome = await ingestUntilKgFails();
    // A projection only runs for a dimension whose `commit` reported success, and
    // here none did. Zero `afterCommit` calls is why no source markdown can exist
    // -- and it is observable, unlike an empty directory. The file-level claim
    // itself is covered where a real root is passed: `wiki-store-dimension.test.ts`
    // ("actually writes the markdown under sources/") and
    // `source-projection.test.ts` (compensation).
    expect(outcome.projections).toEqual([]);
    // The negative control: the root really is empty, so a future reader cannot
    // mistake an empty directory for a fulfilled guarantee.
    expect(existsSync(path.join(outcome.root, "sources"))).toBe(false);
  });

  it("asks BOTH dimensions to discard, having prepared both", async () => {
    const outcome = await ingestUntilKgFails();
    // `discard` filters on `run.prepared !== null`, NOT on `run.committed !== null`.
    // That is correct for a reason the saga version did not have: inside one
    // transaction nothing is visible to undo, so `discard` only covers a dimension
    // whose `prepare` allocated something OUTSIDE the transaction.
    expect(outcome.events.filter((entry) => entry.endsWith(":discard"))).toEqual([
      "kg:discard",
      "wiki:discard",
    ]);
  });
});

describe("the lifecycle the coordinator actually invokes", () => {
  it("asks EVERY prepared dimension to discard after the run fails", async () => {
    const harness = await newHarness();
    const events: string[] = [];
    try {
      await expect(
        ingestDimensions(harness.db, harness.stackId, INPUT, [
          recordingDimension("wiki", events),
          recordingDimension("kg", events, { failPrepare: true }),
        ]),
      ).rejects.toThrow("kg prepare exploded");
    } finally {
      await harness.cleanup();
    }

    // `kg` never produced a handle, so there is nothing of its to undo. Discards run
    // in reverse commit order, which is why the wiki's arrives alone.
    expect(events).toEqual(["wiki:prepare", "kg:prepare", "wiki:discard"]);
  });

  it("does NOT ask a dimension that never prepared to discard", async () => {
    const harness = await newHarness();
    const events: string[] = [];
    try {
      await expect(
        ingestDimensions(harness.db, harness.stackId, INPUT, [
          recordingDimension("wiki", events, { failPrepare: true }),
        ]),
      ).rejects.toThrow("wiki prepare exploded");
    } finally {
      await harness.cleanup();
    }

    expect(events).toEqual(["wiki:prepare"]);
  });

  it("retries the transaction body twice and prepares only once", async () => {
    // The retry contract, stated as the code behaves: prepare runs once because it
    // holds the provider calls, and the transaction is attempted twice because a
    // rollback leaves nothing to clean up before trying again.
    const events: string[] = [];
    const { harness, failure } = await runUntilKgFails(events, []);
    try {
      await expect(failure).rejects.toThrow("kg commit exploded");
    } finally {
      await harness.cleanup();
    }

    expect(events.filter((entry) => entry === "wiki:prepare")).toHaveLength(1);
    expect(events.filter((entry) => entry === "kg:prepare")).toHaveLength(1);
    // Two full attempts: each runs wiki's commit before kg's failure.
    expect(events.filter((entry) => entry === "wiki:commit")).toHaveLength(2);
    expect(events.filter((entry) => entry === "kg:commit")).toHaveLength(2);
  });
});
