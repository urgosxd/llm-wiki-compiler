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
