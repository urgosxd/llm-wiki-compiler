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

describe("cross-dimension failure with a database-backed wiki", () => {
  it("keeps the already-committed wiki write instead of rolling it back", async () => {
    const root = await projectRoot();
    const written = { value: false };

    await expect(
      ingestDimensions(root, INPUT, [databaseShapedWiki(written), explodingDimension()]),
    ).rejects.toThrow("kg commit exploded");

    // THE REAL BEHAVIOUR, stated rather than mourned: the wiki write stands.
    expect(written.value).toBe(true);
  });

  it("leaves NO pending record, because a no-op discard reads as a clean rollback", async () => {
    const root = await projectRoot();
    const written = { value: false };

    await expect(
      ingestDimensions(root, INPUT, [databaseShapedWiki(written), explodingDimension()]),
    ).rejects.toThrow("kg commit exploded");

    const { records, unreadable } = await loadRecords(root);
    expect(unreadable).toHaveLength(0);
    // MEASURED, AND A DEFECT. `rollbackCommitted` records a failure only when
    // `discard` THROWS. A dimension that silently does nothing counts as having
    // rolled back, so the coordinator removes the record it should keep. The
    // wiki row survives (test 1) while this record vanishes: a half-applied
    // ingest with nothing pointing at it.
    expect(records).toHaveLength(0);
    // Pinned as `pending` in the assertion ABOVE would have been the correct
    // behaviour, and is what W3.1 must restore. This line is the defect report.
    expect(written.value).toBe(true);
  });

  it("does NOT claim the old filesystem guarantee, because it no longer holds", async () => {
    const root = await projectRoot();
    const written = { value: false };

    await expect(
      ingestDimensions(root, INPUT, [databaseShapedWiki(written), explodingDimension()]),
    ).rejects.toThrow("kg commit exploded");

    // The old suite asserted `sources/` was empty here. On the database path no
    // such directory is touched, so an assertion about it would pass vacuously
    // and prove nothing -- exactly the trap this file now refuses to fall into.
    expect(existsSync(path.join(root, "sources"))).toBe(false);
  });
});
