/**
 * @file test/dimensions/cross-dimension-rollback.test.ts
 * @description What actually happens to the wiki when a LATER dimension fails:
 * the write survives, and the outbox carries the debt.
 *
 * ## THIS SUITE CHANGED ITS SUBJECT, AND THAT IS THE POINT
 *
 * It used to assert the opposite: that a `kg` commit failure leaves `sources/`
 * empty, because the wiki write was rolled back. That held while the wiki was
 * file-backed, whose `discard` replays the journal's recorded pre-state.
 *
 * The wiki is moving to Postgres, and there `discard` is **deliberately empty**
 * (`store-dimension.ts`: "nothing to undo: `prepare` only reads and computes").
 * That comment is true of `prepare` and false about how the coordinator uses
 * `discard`: `rollbackCommitted` (`coordinator.ts:99-112`) calls it on dimensions
 * that have ALREADY COMMITTED -- it is the compensation path. Against Postgres it
 * returns `undefined` and the row stays.
 *
 * So the old guarantee is gone, not broken. This suite now measures the real
 * behaviour instead of a property nobody provides. Recording it is the point:
 * a green suite over a guarantee we no longer have would hide the regression far
 * better than a red one.
 *
 * ## Where the durability DID NOT move, which is worse than losing a guarantee
 *
 * The intent was that cross-store safety becomes EVENTUAL: the outbox record is
 * persisted before the first commit, so a failure after the wiki write leaves the
 * row AND a durable debt for `reconcile.ts`. That intent does not survive contact
 * with `discard` being a silent no-op, and this suite measures it:
 *
 *   `coordinator.ts:152-158` keeps the `pending` record ONLY when
 *   `rollbackFailures.length > 0`. A no-op `discard` returns normally, so it
 *   counts as a SUCCESSFUL rollback, so the coordinator takes the `else` branch
 *   and calls `removeRecord`. Both the page AND the record are gone.
 *
 * So the failure mode is not "eventually consistent". It is a HALF-APPLIED
 * INGEST WITH NO RECOVERY TRAIL: the wiki row exists, `kg` never wrote, and
 * nothing records that these two facts disagree. `reconcile.ts` cannot replay a
 * debt it cannot see.
 *
 * This is the W3.1 question ("decide the coordinator ordering and rollback story
 * now that both dimensions are remote") arriving earlier and sharper than the
 * plan expected. It must be answered before the file-backed dimension is deleted,
 * not after: today the filesystem `discard` genuinely reverts, which is the only
 * reason the record can be safely removed. Removing that dimension removes the
 * condition the coordinator's `else` branch depends on.
 *
 * ## How this suite is written
 *
 * It uses a stub wiki dimension whose `discard` is a no-op -- faithful to
 * `store-dimension.ts` -- rather than a real Postgres handle. Two reasons: the
 * property under test is the COORDINATOR's bookkeeping, which needs no database,
 * and a real handle would make the suite skip whenever Postgres is absent, so the
 * statement about lost atomicity would be verified only sometimes.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import { loadRecords } from "../../src/dimensions/outbox.js";
import { reconcileOutbox } from "../../src/dimensions/reconcile.js";
import type { Dimension } from "../../src/dimensions/types.js";

/** One document, as an ingest would hand it to the coordinator. */
const INPUT = { source: "https://example.test/a", title: "A", document: "# A\nbody", body: "body" };

/** A fresh project root for the outbox. */
async function projectRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "dim-rollback-")));
}

/**
 * A wiki dimension shaped like `createWikiStoreDimension`.
 *
 * `commit` records that it wrote, and `discard` does NOTHING -- the measured
 * behaviour of the database-backed dimension. If a future change gives that
 * dimension a real compensating discard, this stub must change with it, and this
 * suite is where that shows up.
 */
function databaseShapedWiki(written: { value: boolean }): Dimension {
  return {
    name: "wiki",
    prepare: async () => ({ unchanged: false, handle: {} }),
    commit: async () => {
      written.value = true;
      return { idempotencyKey: "wiki:row", summary: "wiki:created" };
    },
    discard: async () => {
      // Mirrors store-dimension.ts: a transaction was never held open, so there
      // is nothing this dimension can undo after commit.
    },
  };
}

/** A second dimension that prepares cleanly and then fails at commit. */
function explodingDimension(): Dimension {
  return {
    name: "kg",
    prepare: async () => ({ unchanged: false, handle: {} }),
    commit: async () => {
      throw new Error("kg commit exploded");
    },
    discard: async () => {},
  };
}

/** What one failed ingest left behind, which is what every case here inspects. */
interface FailureOutcome {
  readonly root: string;
  readonly wikiCommitted: boolean;
  readonly records: Awaited<ReturnType<typeof loadRecords>>;
}

/**
 * Drive the one scenario this whole suite is about: the wiki commits, then a
 * later dimension fails.
 *
 * Extracted so all three cases inspect the SAME run. Duplicating the setup would
 * let them drift onto subtly different stubs, which is the failure mode a suite
 * about consistent behaviour can least afford.
 *
 * @returns The project root and what the failed ingest left behind.
 */
async function ingestUntilKgFails(): Promise<FailureOutcome> {
  const root = await projectRoot();
  const written = { value: false };

  await expect(
    ingestDimensions(root, INPUT, [databaseShapedWiki(written), explodingDimension()]),
  ).rejects.toThrow("kg commit exploded");

  return { root, wikiCommitted: written.value, records: await loadRecords(root) };
}

describe("cross-dimension failure with a database-backed wiki", () => {
  it("keeps the already-committed wiki write instead of rolling it back", async () => {
    const outcome = await ingestUntilKgFails();
    // THE REAL BEHAVIOUR, stated rather than mourned: the wiki write stands.
    expect(outcome.wikiCommitted).toBe(true);
  });

  /*
   * THE DEFECT WAS HERE, AND IS NOW CLOSED.
   *
   * This case used to assert `toHaveLength(0)`, which was the measured truth
   * while `rollbackCommitted` recorded a failure only when `discard` THREW. A
   * dimension that committed and then returned quietly counted as cleanly rolled
   * back, so the coordinator DELETED the record for a half-applied ingest -- the
   * wiki row stayed while the only trail to it vanished, and `reconcileOutbox`
   * had nothing to replay.
   *
   * `e71da25` makes the coordinator consult `run.committed` instead of inferring
   * success from silence, so the record survives as `pending`. It is pinned here
   * because the guarantee is now a property of the product, not of a comment.
   */
  it("keeps the pending record so the ingest can be replayed", async () => {
    const outcome = await ingestUntilKgFails();
    expect(outcome.records.unreadable).toHaveLength(0);
    expect(outcome.records.records).toHaveLength(1);
    expect(outcome.records.records[0]?.status).toBe("pending");
    expect(outcome.wikiCommitted).toBe(true);
  });

  it("does NOT claim the old filesystem guarantee, because it no longer holds", async () => {
    const outcome = await ingestUntilKgFails();
    // The old suite asserted `sources/` was empty here. On the database path no
    // such directory is touched, so an assertion about it would pass vacuously
    // and prove nothing -- exactly the trap this file now refuses to fall into.
    expect(existsSync(path.join(outcome.root, "sources"))).toBe(false);
  });
});

/**
 * A dimension that records what the coordinator asked of it.
 *
 * Used by the three cases below because each one is about WHICH lifecycle steps
 * the coordinator invokes, not about what a dimension does with them.
 */
function recordingDimension(
  name: "wiki" | "kg",
  events: string[],
  behaviour: { failCommit?: boolean; failPrepare?: boolean } = {},
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
      return { idempotencyKey: `${name}:key`, summary: `${name}:created` };
    },
    discard: async () => {
      events.push(`${name}:discard`);
    },
  };
}

describe("the lifecycle the coordinator actually invokes", () => {
  it("asks EVERY prepared dimension to discard after an earlier failure", async () => {
    // MEASURED, AND WORTH STATING PRECISELY: `rollbackCommitted` filters on
    // `run.prepared !== null`, NOT on `run.committed !== null`. So the wiki --
    // which prepared but never committed -- still receives `discard`. The name
    // says "Committed" and the guard says "prepared"; they disagree.
    //
    // This is safe today only because a prepared-but-uncommitted write has
    // nothing to undo (both dimension implementations are no-ops in discard). It
    // is pinned here so a future dimension whose discard is NOT a no-op cannot
    // silently start reverting work that was never done.
    const root = await projectRoot();
    const events: string[] = [];

    await expect(
      ingestDimensions(root, INPUT, [
        recordingDimension("wiki", events),
        recordingDimension("kg", events, { failPrepare: true }),
      ]),
    ).rejects.toThrow("kg prepare exploded");

    expect(events).toEqual(["wiki:prepare", "kg:prepare", "wiki:discard"]);
    // And nothing is left pending, because the quiet discard reads as a clean
    // rollback -- correct here, since nothing was ever committed.
    const { records } = await loadRecords(root);
    expect(records).toHaveLength(0);
  });

  it("does NOT ask a dimension that never prepared to discard", async () => {
    // The other half of the guard: a dimension whose `prepare` threw before
    // assigning has `prepared === null`, so the loop skips it entirely.
    const root = await projectRoot();
    const events: string[] = [];

    await expect(
      ingestDimensions(root, INPUT, [recordingDimension("wiki", events, { failPrepare: true })]),
    ).rejects.toThrow("wiki prepare exploded");

    expect(events).toEqual(["wiki:prepare"]);
  });

  it("replays only the dimensions that never landed, and does so once", async () => {
    // Idempotence of reconciliation, stated as the code actually behaves. The
    // wiki committed before kg failed, so its key is already in the record and
    // the replay SKIPS it -- "skipping is strictly cheaper" per reconcile.ts.
    // Only kg, which has no key, is retried. A second pass finds no record at
    // all, so neither dimension can be committed a third time.
    const root = await projectRoot();
    const events: string[] = [];
    const healthyWiki = recordingDimension("wiki", events);

    await expect(
      ingestDimensions(root, INPUT, [healthyWiki, recordingDimension("kg", events, { failCommit: true })]),
    ).rejects.toThrow("kg commit exploded");

    // The failure run, measured: BOTH prepares run first, then commits in order,
    // then discards. `ingestDimensions` has two separate loops, not one.
    expect(events).toEqual([
      "wiki:prepare",
      "kg:prepare",
      "wiki:commit",
      "kg:commit",
      "kg:discard",
      "wiki:discard",
    ]);

    const first = await reconcileOutbox(root, [recordingDimension("wiki", events), recordingDimension("kg", events)]);
    expect(first.finished).toHaveLength(1);
    // wiki:commit is NOT repeated -- its key was already recorded.
    expect(events.filter((entry) => entry === "wiki:commit")).toHaveLength(1);
    // kg IS retried, exactly once.
    expect(events.filter((entry) => entry === "kg:commit")).toHaveLength(2);

    const second = await reconcileOutbox(root, [recordingDimension("wiki", events), recordingDimension("kg", events)]);
    expect(second.finished).toHaveLength(0);
    // Nothing runs a third time: the record is gone.
    expect(events.filter((entry) => entry === "kg:commit")).toHaveLength(2);
  });
});
