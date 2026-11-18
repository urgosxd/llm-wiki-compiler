/**
 * @file test/services/ingest-job-delete.test.ts
 * @description S2: a job is deletable exactly when an operator needs it, and every
 * refusal leaves the stored row BYTE-IDENTICAL.
 *
 * THE TWO HALVES OF THE RULE. "no hay manera de eliminarlo" is answered by a delete that
 * exists; the danger of answering it badly is a delete that also removes a job which is
 * still working, orphaning real work from its own status surface. So the policy has to
 * refuse on purpose, and a refusal has to be provably inert.
 *
 * WHY WHOLE-ROW EQUALITY. A counter says nothing about an UPDATE: a refusal that quietly
 * rewrote `updated_at`, moved a status, or rewrote the `jsonb` payload leaves
 * `count(*) = 1` before and after. The comparison here is therefore each row's own
 * canonical text (`test/fixtures/tenant-snapshot.ts`), which is the only form in which
 * "nothing changed" is a literal claim.
 *
 * WHY THE CLOCK AND THE BOUND ARE INJECTED. The deletability decision is a comparison
 * between `updatedAt` and a named bound. Passing both in makes every case below exact: no
 * case waits, and none of them depends on how long the machine took.
 */
import { describe, expect, it } from "vitest";
import {
  deleteRecoverableJob,
  deletabilityOf,
} from "../../packages/wiki/src/services/ingest/jobs/delete.js";
import type {
  DeleteIngestJobOutcome,
  DeleteRefusalReason,
} from "../../packages/wiki/src/services/ingest/jobs/delete.js";
import { createDurableJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import type { DurableJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import {
  deleteIngestJobAtVersion,
  listIngestJobs,
  readIngestJob,
  saveIngestJob,
} from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import { createJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import type { JobStatusOptions } from "../../packages/wiki/src/services/ingest/jobs/status.js";
import { ingestJobRows, runningJobRow, settledJobRow } from "../fixtures/ingest-job-rows.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { stackHarnessRunner, wikiReachable } from "../fixtures/stack-harness.js";

/** Id of the job every case stores. Shape `ing_<ULID>`, as the registry mints them. */
const JOB_ID = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FD";

/** The instant the read under test happens. Fixed, so no assertion depends on "now". */
const READ_AT = new Date("2024-06-01T00:00:00.000Z");

/** A silence an hour long: past a one-minute bound by construction. */
const SILENT_SINCE = "2024-05-31T23:00:00.000Z";

/** Thirty seconds of silence: INSIDE a one-minute bound, so the job may be working. */
const MOVED_RECENTLY = "2024-05-31T23:59:30.000Z";

/** Exactly the bound of silence: not yet PAST it, so still possibly working. */
const ON_THE_BOUND = "2024-05-31T23:59:00.000Z";

/** One minute, in milliseconds: the named bound every case below reads. */
const BOUND_MS = 60_000;

/** Clock and bound, both fixed; see this file's header. */
const OPTIONS: JobStatusOptions = { now: READ_AT, stuckAfterMs: BOUND_MS };

/** The one table this suite cannot run without; probed through the shared helper. */
const harnessReachable = await wikiReachable("job-delete");

/** A run over throwaway Stacks labelled for this file. */
const withJobStack = stackHarnessRunner("job-delete");

/**
 * Narrow a refusal and hand back its reason and message.
 *
 * A discriminated refusal is read through one place so a case cannot assert a reason
 * against an outcome that deleted the job — `deleted: false` is asserted first.
 *
 * @param outcome - What the policy answered.
 * @returns The reason the delete was refused, and the message a surface renders.
 */
function refusalOf(outcome: DeleteIngestJobOutcome): {
  reason: DeleteRefusalReason;
  message: string;
} {
  expect(outcome.deleted).toBe(false);
  if (outcome.deleted) throw new Error("the job was deleted, so there is no refusal to read");
  return { reason: outcome.reason, message: outcome.message };
}

/**
 * Mirror a settled job into Postgres through a durable registry.
 *
 * The live registry drops SETTLED entries older than its own hour-long retention window, and
 * this case needs the live entry present, so the clock here is minutes old rather than the
 * fixed instant the other cases use.
 *
 * @param harness - The suite's Stack.
 * @returns The job id, the clock the delete is decided at, and the registry that holds it.
 */
async function seedSettledDurableJob(
  harness: KgPostgresHarness,
): Promise<{ jobId: string; now: Date; registry: DurableJobRegistry }> {
  const now = new Date();
  const settledAt = new Date(now.getTime() - 10 * 60_000);
  const registry = createDurableJobRegistry(createJobRegistry(), {
    db: harness.db,
    stackId: harness.stackId,
  });
  const created = registry.create("note.md", settledAt, harness.stackId);
  const endedAt = settledAt.toISOString();
  registry.patchIngest(created.id, { status: "unchanged", endedAt }, settledAt);
  registry.patchCompile(created.id, { status: "skipped" }, settledAt);
  await registry.flushMirror(5_000);
  return { jobId: created.id, now, registry };
}

describe("what the delete policy allows", () => {
  it("allows a settled job", () => {
    expect(deletabilityOf(settledJobRow(JOB_ID, SILENT_SINCE), OPTIONS)).toBe("settled");
  });

  it("allows a job that stopped moving past the bound", () => {
    // Non-terminal, and silent for an hour against a one-minute bound: this is the stuck
    // row the reporter could not clear.
    expect(deletabilityOf(runningJobRow(JOB_ID, SILENT_SINCE), OPTIONS)).toBe("stalled");
  });

  it("refuses a non-terminal job that moved inside the bound", () => {
    expect(deletabilityOf(runningJobRow(JOB_ID, MOVED_RECENTLY), OPTIONS)).toBe("working");
  });

  it("refuses a job sitting exactly on the bound", () => {
    expect(deletabilityOf(runningJobRow(JOB_ID, ON_THE_BOUND), OPTIONS)).toBe("working");
  });
});

describe.skipIf(!harnessReachable)("deleting a job the policy allows", () => {
  it("deletes a settled job from the durable row, the listing and the live registry", async () => {
    await withJobStack(async (harness) => {
      const seeded = await seedSettledDurableJob(harness);
      expect(await readIngestJob(harness.db, harness.stackId, seeded.jobId)).toBeDefined();

      const outcome = await deleteRecoverableJob(harness.db, harness.stackId, seeded.jobId, {
        now: seeded.now,
        stuckAfterMs: BOUND_MS,
        registry: seeded.registry,
      });

      expect(outcome.deleted).toBe(true);
      // Both halves of the primitive: the durable row, and the live entry this process held.
      expect(await readIngestJob(harness.db, harness.stackId, seeded.jobId)).toBeUndefined();
      expect(await listIngestJobs(harness.db, harness.stackId)).toEqual([]);
      expect(seeded.registry.list()).toEqual([]);
      // And nothing queued behind the delete resurrects it.
      expect(await seeded.registry.flushMirror(5_000)).toEqual([]);
      expect(await readIngestJob(harness.db, harness.stackId, seeded.jobId)).toBeUndefined();
    });
  }, 60_000);

  it("deletes a job that stopped moving past the bound", async () => {
    await withJobStack(async (harness) => {
      await saveIngestJob(harness.db, harness.stackId, runningJobRow(JOB_ID, SILENT_SINCE));

      const outcome = await deleteRecoverableJob(harness.db, harness.stackId, JOB_ID, OPTIONS);

      expect(outcome).toEqual({ deleted: true, job: runningJobRow(JOB_ID, SILENT_SINCE) });
      expect(await readIngestJob(harness.db, harness.stackId, JOB_ID)).toBeUndefined();
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("refusing a delete the policy forbids", () => {
  it("refuses a job still working and leaves its row byte-identical", async () => {
    await withJobStack(async (harness) => {
      await saveIngestJob(harness.db, harness.stackId, runningJobRow(JOB_ID, MOVED_RECENTLY));
      const before = await ingestJobRows(harness);

      const outcome = await deleteRecoverableJob(harness.db, harness.stackId, JOB_ID, OPTIONS);

      expect(refusalOf(outcome).reason).toBe("still-live");
      // Whole rows, not one column: a refusal that rewrote `updated_at`, a status or the
      // payload would still leave `count(*) = 1`.
      expect(await ingestJobRows(harness)).toEqual(before);
      expect((await ingestJobRows(harness)).length).toBe(1);
    });
  }, 60_000);

  it("refuses an unknown id, names it, and changes no row", async () => {
    await withJobStack(async (harness) => {
      await saveIngestJob(harness.db, harness.stackId, runningJobRow(JOB_ID, SILENT_SINCE));
      const before = await ingestJobRows(harness);

      const outcome = await deleteRecoverableJob(harness.db, harness.stackId, "ing_UNKNOWN", OPTIONS);

      expect(refusalOf(outcome)).toEqual({
        reason: "unknown-job",
        message: "No ingest job 'ing_UNKNOWN' for this Stack.",
      });
      expect(await ingestJobRows(harness)).toEqual(before);
    });
  }, 60_000);

  it("cannot delete another Stack's job", async () => {
    await withJobStack(async (owner) => {
      await withJobStack(async (stranger) => {
        await saveIngestJob(owner.db, owner.stackId, settledJobRow(JOB_ID, SILENT_SINCE));
        const ownersRows = await ingestJobRows(owner);
        const strangersRows = await ingestJobRows(stranger);

        const outcome = await deleteRecoverableJob(stranger.db, stranger.stackId, JOB_ID, OPTIONS);

        expect(refusalOf(outcome).reason).toBe("unknown-job");
        // The owner's row survives byte-identically, and the stranger gains nothing.
        expect(await ingestJobRows(owner)).toEqual(ownersRows);
        expect(await ingestJobRows(stranger)).toEqual(strangersRows);
      });
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("the version guard on the delete", () => {
  it("removes the row at the version it was read at", async () => {
    await withJobStack(async (harness) => {
      await saveIngestJob(harness.db, harness.stackId, runningJobRow(JOB_ID, SILENT_SINCE));

      expect(
        await deleteIngestJobAtVersion(harness.db, harness.stackId, JOB_ID, SILENT_SINCE),
      ).toBe(true);
      expect(await readIngestJob(harness.db, harness.stackId, JOB_ID)).toBeUndefined();
    });
  }, 60_000);

  it("refuses a stale version and leaves the newer row byte-identical", async () => {
    await withJobStack(async (harness) => {
      await saveIngestJob(harness.db, harness.stackId, runningJobRow(JOB_ID, SILENT_SINCE));
      // A job that RESUMED between the decision and the delete: same id, newer version.
      await saveIngestJob(harness.db, harness.stackId, runningJobRow(JOB_ID, MOVED_RECENTLY));
      const before = await ingestJobRows(harness);

      expect(
        await deleteIngestJobAtVersion(harness.db, harness.stackId, JOB_ID, SILENT_SINCE),
      ).toBe(false);
      expect(await ingestJobRows(harness)).toEqual(before);
      expect((await ingestJobRows(harness)).length).toBe(1);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("the store's existing reads and writes", () => {
  it("still round-trips a saved job and lists the newest transition first", async () => {
    await withJobStack(async (harness) => {
      const older = settledJobRow("ing_OLDER", SILENT_SINCE);
      const newer = settledJobRow("ing_NEWER", MOVED_RECENTLY);
      await saveIngestJob(harness.db, harness.stackId, older);
      await saveIngestJob(harness.db, harness.stackId, newer);

      expect(await readIngestJob(harness.db, harness.stackId, older.id)).toEqual(older);
      expect((await listIngestJobs(harness.db, harness.stackId)).map((job) => job.id)).toEqual([
        newer.id,
        older.id,
      ]);
    });
  }, 60_000);
});
