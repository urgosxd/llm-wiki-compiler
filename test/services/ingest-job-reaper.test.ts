/**
 * @file test/services/ingest-job-reaper.test.ts
 * @description S6: a row that never settles is SETTLED under a named bound — never deleted, and
 * never settled while it may still be alive.
 *
 * ## What the reporter's third defect actually is
 *
 * "no reaper for `wiki.ingest_job`": a container restart leaves rows `running` from a process
 * that no longer exists, and nothing ever moves them. They stay visible forever and every
 * surface quotes them as work in progress.
 *
 * The two ways to answer that badly are BOTH tested here, because both are silent:
 *
 *  - DELETING on the bound. That is irreversible destruction of stored data on a timer. The row
 *    stays visible instead, carrying a reason that says the conclusion was DERIVED.
 *  - settling a job that is still alive. A live registry entry that is not terminal means THIS
 *    process is holding the job, so the row's silence says nothing about it.
 *
 * ## Why every refusal is proved by whole-row equality
 *
 * A counter says nothing about an UPDATE: a reaper that rewrote a live row's `updated_at`, moved
 * a status or rewrote the `jsonb` payload leaves `count(*) = 1` before and after. So each
 * refusal compares the Stack's own rows as canonical text, which is the only form in which
 * "nothing changed" is a literal claim.
 *
 * ## Why the clock is injected
 *
 * The bound is a comparison between `updatedAt` and `now`. Passing `now` and the bound in makes
 * every case below exact: nothing waits, and no assertion depends on how long the machine took.
 */
import { describe, expect, it } from "vitest";
import {
  abandonedSnapshotOf,
  listStackIds,
  settleAbandonedJobs,
} from "../../packages/wiki/src/services/ingest/jobs/reaper.js";
import type { ReapOptions } from "../../packages/wiki/src/services/ingest/jobs/reaper.js";
import { readIngestJob, saveIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import { createJobRegistry, isSettled, type JobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { ingestJobRows, runningJobRow, settledJobRow } from "../fixtures/ingest-job-rows.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { stackHarnessRunner, wikiReachable } from "../fixtures/stack-harness.js";

/** Id of the job every case stores. Shape `ing_<ULID>`, as the registry mints them. */
const JOB_ID = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FR";

/** The instant the reap happens. Fixed, so no assertion depends on "now". */
const READ_AT = new Date("2024-06-01T00:00:00.000Z");

/** One hour of silence: past a one-minute bound by construction. */
const SILENT_SINCE = "2024-05-31T23:00:00.000Z";

/** Thirty seconds of silence: INSIDE a one-minute bound, so the job may still be working. */
const MOVED_RECENTLY = "2024-05-31T23:59:30.000Z";

/** Exactly the bound of silence: not yet PAST it, so still possibly working. */
const ON_THE_BOUND = "2024-05-31T23:59:00.000Z";

/** A write from a process we thought was gone, landing AFTER the reap happened. */
const LATER = "2024-06-01T00:10:00.000Z";

/** One minute, in milliseconds: the named bound every case below reads. */
const BOUND_MS = 60_000;

/**
 * The reason the reaper writes: DERIVED, and it says so in its own first word.
 *
 * A read-time inference and a recorded fact must not be confusable, so the sentence names
 * itself and quotes the instant the row last moved rather than the instant of the reap.
 */
const ABANDONED_REASON =
  `abandoned: no update since ${SILENT_SINCE}; the process that owned it stopped`;

/** Clock and bound, both fixed; see this file's header. */
const OPTIONS: ReapOptions = { now: READ_AT, stuckAfterMs: BOUND_MS };

/** The one table this suite cannot run without; probed through the shared helper. */
const harnessReachable = await wikiReachable("job-reaper");

/** A run over throwaway Stacks labelled for this file. */
const withJobStack = stackHarnessRunner("job-reaper");

/**
 * Store one snapshot in a harness's own Stack.
 *
 * @param harness - The Stack's database.
 * @param job - The snapshot to store.
 */
function storeRow(harness: KgPostgresHarness, job: IngestJob): Promise<void> {
  return saveIngestJob(harness.db, harness.stackId, job);
}

/**
 * Read back a job from a Stack's own rows.
 *
 * @param harness - The Stack's database.
 * @param jobId - The id to read; the case's own job unless it minted one.
 */
function storedJob(harness: KgPostgresHarness, jobId: string = JOB_ID): Promise<IngestJob | undefined> {
  return readIngestJob(harness.db, harness.stackId, jobId);
}

/**
 * A live view holding exactly the snapshot a case wants to state.
 *
 * A stub rather than a real registry on purpose: `createJobRegistry` drops a SETTLED job an hour
 * after it finished, so a real registry cannot represent "this process finished this job" beside
 * a row that is hours old — and what a case here needs to state is precisely that pair of facts.
 *
 * @param job - The one snapshot this process holds, or `undefined` for a process holding nothing.
 * @returns The live view the reap is given.
 */
function registryHolding(job: IngestJob | undefined): Pick<JobRegistry, "get"> {
  return { get: (id: string) => (job !== undefined && id === job.id ? job : undefined) };
}

/** Run one reap over the harness's own Stack, with the case's clock and bound. */
function reap(
  harness: KgPostgresHarness,
  options: ReapOptions = OPTIONS,
): ReturnType<typeof settleAbandonedJobs> {
  return settleAbandonedJobs(harness.db, [harness.stackId], options);
}

/**
 * Assert that a reap settles NOTHING and leaves every row of the Stack byte-identical.
 *
 * The whole of a refusal, in one place: the outcome, the rows as canonical text, and the count,
 * so no case can prove "nothing happened" with a weaker comparison than another.
 *
 * @param harness - The Stack whose rows must not move.
 * @param options - Clock, bound, and the live view the reap is given.
 */
async function expectNothingSettled(
  harness: KgPostgresHarness,
  options: ReapOptions = OPTIONS,
): Promise<void> {
  const before = await ingestJobRows(harness);
  expect(await reap(harness, options)).toEqual({ settled: [], skipped: 0 });
  expect(await ingestJobRows(harness)).toEqual(before);
}

/**
 * A job whose ingest half FINISHED and whose compile half is still running.
 *
 * The hard case for a reaper, and the one that proves it cannot fabricate a failure: the ingest
 * succeeded, so settling it as failed would overwrite a fact the row already knew.
 *
 * @param id - The job id to store.
 * @param stamp - The instant it was created and last moved.
 * @returns The snapshot, carrying an attempt record and a real progress pair to preserve.
 */
function compileOnlyJobRow(id: string, stamp: string): IngestJob {
  return {
    id,
    source: "notes/deep-dive.md",
    createdAt: stamp,
    updatedAt: stamp,
    ingest: {
      status: "succeeded",
      stage: "journaling",
      startedAt: stamp,
      endedAt: stamp,
      attempts: [{ attempt: 1, startedAt: stamp, endedAt: stamp }],
      message: "Wrote 3 pages.",
    },
    compile: {
      status: "running",
      stage: "page_generation",
      startedAt: stamp,
      progress: { completed: 2, total: 10 },
      detail: { chunks: 42 },
      message: "Generating pages.",
    },
  };
}

describe.skipIf(!harnessReachable)("settling a row that stopped moving", () => {
  it("settles it, names the instant it stopped, and preserves what it knew", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, compileOnlyJobRow(JOB_ID, SILENT_SINCE));

      const outcome = await reap(harness);

      expect(outcome).toEqual({ settled: [{ stackId: harness.stackId, jobId: JOB_ID }], skipped: 0 });
      const stored = await storedJob(harness);
      expect(stored !== undefined && isSettled(stored)).toBe(true);
      // The row is still THERE: settling is not deleting, and the operator can still read it.
      expect(await ingestJobRows(harness)).toHaveLength(1);
      // The ingest half had already finished, so it is left exactly as it was: a reap must not
      // rewrite a landed ingest as a failure.
      expect(stored?.ingest).toEqual(compileOnlyJobRow(JOB_ID, SILENT_SINCE).ingest);
      // The half that never finished is settled, and the reason says the conclusion was derived.
      expect(stored?.compile.error).toBe(ABANDONED_REASON);
      // Everything the row knew about that half survives: stage, progress, detail, message.
      expect(stored?.compile.stage).toBe("page_generation");
      expect(stored?.compile.progress).toEqual({ completed: 2, total: 10 });
      expect(stored?.compile.detail).toEqual({ chunks: 42 });
      expect(stored?.compile.message).toBe("Generating pages.");
      expect(stored?.source).toBe("notes/deep-dive.md");
      expect(stored?.createdAt).toBe(SILENT_SINCE);
    });
  }, 60_000);

  it("stamps the settled row with the reap instant, so the version guard can order it", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, runningJobRow(JOB_ID, SILENT_SINCE));

      await reap(harness);

      const stored = await storedJob(harness);
      expect(stored?.updatedAt).toBe(READ_AT.toISOString());
      // The machine-readable provenance of the sentence below: a read reports `kind: "derived"`
      // because of THIS field, never by inspecting the text.
      expect(stored?.abandonedAt).toBe(READ_AT.toISOString());
      expect(stored?.ingest.error).toBe(ABANDONED_REASON);
      expect(stored?.ingest.endedAt).toBe(READ_AT.toISOString());
      expect(stored?.ingest.stage).toBe("fetching");
      expect(stored?.compile.error).toBe(ABANDONED_REASON);
      expect(stored?.compile.progress).toBeNull();
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("what the reaper must NOT touch", () => {
  it("leaves a settled row byte-identical, and the count unchanged", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, settledJobRow(JOB_ID, SILENT_SINCE));

      await expectNothingSettled(harness);

      expect(await ingestJobRows(harness)).toHaveLength(1);
    });
  }, 60_000);

  it("leaves a row that moved INSIDE the bound alone, including one exactly ON it", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, runningJobRow(JOB_ID, MOVED_RECENTLY));
      await storeRow(harness, runningJobRow("ing_ONBOUND", ON_THE_BOUND));

      // The refusal that protects live work: a silent row may be a busy one.
      await expectNothingSettled(harness);

      expect(await ingestJobRows(harness)).toHaveLength(2);
    });
  }, 60_000);

  it("settles nothing the second time it runs", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, runningJobRow(JOB_ID, SILENT_SINCE));

      const first = await reap(harness);
      const afterFirst = await ingestJobRows(harness);

      expect(first.settled).toEqual([{ stackId: harness.stackId, jobId: JOB_ID }]);
      await expectNothingSettled(harness);
      expect(await ingestJobRows(harness)).toEqual(afterFirst);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("a job that is alive, and a tenant that is not this one", () => {
  it("skips a row this process is still running, and counts it", async () => {
    await withJobStack(async (harness) => {
      const registry = createJobRegistry();
      const live = registry.create("note.md", new Date(SILENT_SINCE));
      // The durable row says exactly what a dead process leaves behind, but THIS process holds
      // the job and it is not terminal, so the silence is not evidence of anything.
      await storeRow(harness, runningJobRow(live.id, SILENT_SINCE));
      const before = await ingestJobRows(harness);

      expect(await reap(harness, { ...OPTIONS, registry })).toEqual({ settled: [], skipped: 1 });
      expect(await ingestJobRows(harness)).toEqual(before);
      expect((await storedJob(harness, live.id))?.ingest.status).toBe("running");
    });
  }, 60_000);

  it("cannot touch another Stack's identical-looking row", async () => {
    await withJobStack(async (owner) => {
      await withJobStack(async (stranger) => {
        await storeRow(owner, runningJobRow(JOB_ID, SILENT_SINCE));
        await storeRow(stranger, runningJobRow(JOB_ID, SILENT_SINCE));
        const strangersRows = await ingestJobRows(stranger);

        // Only the Stack that was NAMED: the same job id under another tenant is another row.
        expect(await reap(owner)).toEqual({
          settled: [{ stackId: owner.stackId, jobId: JOB_ID }],
          skipped: 0,
        });
        expect(await ingestJobRows(stranger)).toEqual(strangersRows);
        expect(await readIngestJob(stranger.db, stranger.stackId, JOB_ID)).toEqual(
          runningJobRow(JOB_ID, SILENT_SINCE),
        );
      });
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("a job this process already finished", () => {
  it("settles the row with what the live view KNOWS, not with an inference", async () => {
    await withJobStack(async (harness) => {
      // The row lags the truth — its terminal mirror write was lost — and this process still
      // holds the outcome, so settling it `failed/abandoned` would overwrite a known fact.
      const known: IngestJob = {
        ...runningJobRow(JOB_ID, SILENT_SINCE),
        updatedAt: LATER,
        ingest: { status: "succeeded", stage: "journaling", endedAt: LATER, attempts: [] },
        compile: { status: "skipped", progress: null },
      };
      await storeRow(harness, runningJobRow(JOB_ID, SILENT_SINCE));

      expect(await reap(harness, { ...OPTIONS, registry: registryHolding(known) })).toEqual({
        settled: [{ stackId: harness.stackId, jobId: JOB_ID }],
        skipped: 0,
      });
      expect(await storedJob(harness)).toEqual(known);
      expect((await storedJob(harness))?.ingest.error).toBeUndefined();
    });
  }, 60_000);

  it("refuses when the live view is OLDER than the row, because the row is the newer record", async () => {
    await withJobStack(async (harness) => {
      const older = settledJobRow(JOB_ID, "2024-05-31T22:00:00.000Z");
      await storeRow(harness, runningJobRow(JOB_ID, SILENT_SINCE));
      const before = await ingestJobRows(harness);

      // Writing the older snapshot would replace a newer record with an older one, so the run
      // declines and counts it instead of reporting a settle that did not happen.
      expect(await reap(harness, { ...OPTIONS, registry: registryHolding(older) })).toEqual({
        settled: [],
        skipped: 1,
      });
      expect(await ingestJobRows(harness)).toEqual(before);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("a healthy write is never overtaken by the reaper", () => {
  it("leaves a late write alone on a re-run, even one that is stale by then", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, runningJobRow(JOB_ID, SILENT_SINCE));
      await reap(harness);
      // The process we thought had stopped writes again, AFTER the reap: it is alive, and its
      // row is newer than the reap. A second run must not settle it.
      await storeRow(harness, runningJobRow(JOB_ID, LATER));

      await expectNothingSettled(harness);

      expect((await storedJob(harness))?.ingest.status).toBe("running");
    });
  }, 60_000);

  it("cannot overwrite a newer TERMINAL state", async () => {
    await withJobStack(async (harness) => {
      await storeRow(harness, runningJobRow(JOB_ID, SILENT_SINCE));
      await reap(harness);
      await storeRow(harness, settledJobRow(JOB_ID, LATER));

      await expectNothingSettled(harness);

      expect(await storedJob(harness)).toEqual(settledJobRow(JOB_ID, LATER));
    });
  }, 60_000);

  it("hands its own write to the store's version guard, which refuses it over a newer row", async () => {
    await withJobStack(async (harness) => {
      // The exact snapshot a reap produces, and the row it would land on: newer than the reap.
      const snapshot = abandonedSnapshotOf(runningJobRow(JOB_ID, SILENT_SINCE), READ_AT.toISOString());
      await storeRow(harness, runningJobRow(JOB_ID, LATER));
      const before = await ingestJobRows(harness);

      await storeRow(harness, snapshot);

      // Refused by `updated_at`, so the newer row survives: the reaper cannot clobber a write
      // that happened after it took its clock.
      expect(await ingestJobRows(harness)).toEqual(before);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("naming the Stacks to reap", () => {
  it("lists the Stacks this deployment has, so a boot can name them", async () => {
    await withJobStack(async (harness) => {
      expect(await listStackIds(harness.db)).toContain(harness.stackId);
    });
  }, 60_000);
});
