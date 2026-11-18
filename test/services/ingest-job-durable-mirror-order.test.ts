/**
 * @file test/services/ingest-job-durable-mirror-order.test.ts
 * @description The durable mirror's ORDER, proved without a database.
 *
 * WHY THIS FILE EXISTS SEPARATE FROM THE DATABASE SUITE. The row-level cases live in
 * `ingest-job-durable-settle.test.ts` and need Postgres; the property that a job's
 * writes are sequenced is visible at the boundary between the mirror and its handle,
 * and that boundary is a `DatabaseHandle`. So it is held to here, cheaply, by a handle
 * that deliberately finishes its FIRST write last: with nothing sequencing the writes,
 * the oldest snapshot is the one that commits last — the measured hang.
 *
 * The handle is the collaborator, not the store: these cases assert the order in which
 * writes are issued and settled, and that a failed write is reported instead of
 * disappearing. They do not restate what `job-store.ts` puts in a row.
 *
 * `finished` counts a write as done when its transaction returned, which is when the
 * row it wrote is durable. Order of finishing IS order of committing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createDurableJobRegistry,
  type DurableRegistryOptions,
} from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import { createJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";

/** Long enough that the slow write is still open while the others would run. */
const SLOW_FIRST_WRITE_MS = 75;

/** Wait long enough for three sequenced round trips, fail rather than hang. */
const SETTLE_TIMEOUT_MS = 5_000;

/** The Stack these jobs belong to; nothing here resolves it. */
const STACK = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** A handle that finishes its first write LAST, plus the order its writes finished in. */
interface OutOfOrderHandle {
  readonly db: DurableRegistryOptions["db"];
  /** Entry number of each write, in the order the writes FINISHED. */
  readonly finished: number[];
  /** Most writes that were ever open at the same moment. */
  peak(): number;
}

/**
 * Build a handle whose first write is the slowest one, by construction.
 *
 * A delay keyed to the entry number rather than a sleep race: the ordering is guaranteed
 * by which write it is, so the case cannot pass or fail on timing luck. Statements are
 * answered here instead of a server, and nothing here asserts what they mean.
 *
 * @returns The wrapped handle plus its observation points.
 */
function outOfOrderHandle(): OutOfOrderHandle {
  const finished: number[] = [];
  let entered = 0;
  let open = 0;
  let peak = 0;
  const tx = {
    execute: async (): Promise<unknown[]> => [],
    transaction: (): Promise<never> => Promise.reject(new Error("no nested transaction")),
  };
  const db = {
    // Statements never arrive here directly: `saveIngestJob` reaches the database
    // through `withTenant`, so every mirror write this handle sees is a TRANSACTION.
    execute: async (): Promise<unknown[]> => [],
    transaction: async (run: (inner: unknown) => Promise<unknown>) => {
      entered += 1;
      const entry = entered;
      open += 1;
      peak = Math.max(peak, open);
      if (entry === 1) await new Promise((resolve) => setTimeout(resolve, SLOW_FIRST_WRITE_MS));
      try {
        return await run(tx);
      } finally {
        open -= 1;
        finished.push(entry);
      }
    },
  };
  return { db: db as unknown as DurableRegistryOptions["db"], finished, peak: () => peak };
}

/**
 * A handle whose every write fails, in the order its writes finished.
 *
 * @param finished - The list the entry number of each write is appended to.
 * @returns A handle that refuses both the statement and the transaction around it.
 */
function refusingWritesTracked(finished: number[]): DurableRegistryOptions["db"] {
  const refuse = (): Promise<never> => Promise.reject(new Error("the mirror write failed"));
  const tx = { execute: refuse, transaction: refuse };
  let entered = 0;
  const db = {
    execute: refuse,
    transaction: async (run: (inner: unknown) => Promise<unknown>) => {
      entered += 1;
      const entry = entered;
      try {
        return await run(tx);
      } finally {
        finished.push(entry);
      }
    },
  };
  return db as unknown as DurableRegistryOptions["db"];
}

/**
 * A handle whose every write fails.
 *
 * @returns A handle that refuses both the statement and the transaction around it.
 */
function refusingWrites(): DurableRegistryOptions["db"] {
  const refuse = (): Promise<never> => Promise.reject(new Error("the mirror write failed"));
  return { execute: refuse, transaction: refuse } as unknown as DurableRegistryOptions["db"];
}

/**
 * Drive one job through three patches whose first write is the slowest.
 *
 * @returns The wrapped handle, so a case can read the finish order.
 */
function driveOneJob(): OutOfOrderHandle {
  const handle = outOfOrderHandle();
  const registry = createDurableJobRegistry(createJobRegistry(), {
    db: handle.db,
    stackId: STACK,
  });
  const job = registry.create("note.md", new Date());
  registry.patchIngest(job.id, { status: "running", stage: "extracting" }, new Date());
  registry.patchCompile(job.id, { status: "skipped" }, new Date());
  return handle;
}

/** One job's writes commit in the order its patches happened. */
async function writesLandInPatchOrder(): Promise<void> {
  const handle = driveOneJob();

  await vi.waitFor(() => expect(handle.finished).toHaveLength(3), { timeout: SETTLE_TIMEOUT_MS });
  // [1, 2, 3] means the last snapshot to commit is the last patch. An unsequenced
  // mirror finished [2, 3, 1] here: the create snapshot committed last, leaving the
  // row reporting a state the job had already left — the hang, in one assertion.
  expect(handle.finished).toEqual([1, 2, 3]);
  expect(handle.peak()).toBe(1);
}

/** One job's slow write does not hold up another job's. */
async function jobsDoNotWaitForEachOther(): Promise<void> {
  const handle = outOfOrderHandle();
  const registry = createDurableJobRegistry(createJobRegistry(), {
    db: handle.db,
    stackId: STACK,
  });
  // Entry 1 is the slow write; entry 2 belongs to a DIFFERENT job.
  registry.create("slow.md", new Date());
  registry.create("fast.md", new Date());

  await vi.waitFor(() => expect(handle.finished.length).toBeGreaterThan(0), {
    timeout: SETTLE_TIMEOUT_MS,
  });
  // The unrelated job's write finished while the first job's write was still open, so
  // the chain is keyed per job and is not one registry-wide queue.
  expect(handle.finished[0]).toBe(2);
}

/** A failed write is reported, and the job keeps being mirrored afterwards. */
async function failuresAreReportedAndSurvived(): Promise<void> {
  const errors: unknown[] = [];
  const registry = createDurableJobRegistry(createJobRegistry(), {
    db: refusingWrites(),
    stackId: STACK,
    onError: (error) => errors.push(error),
  });
  const job = registry.create("note.md", new Date());
  registry.patchIngest(job.id, { status: "failed" }, new Date());

  await vi.waitFor(() => expect(errors).toHaveLength(2), { timeout: SETTLE_TIMEOUT_MS });
  // Two reports for two failing writes: the second write ran even though the first
  // threw, so a failed mirror neither disappears nor stops mirroring this job.
  expect(errors[0]).toBeInstanceOf(Error);
}

/**
 * A sink that THROWS must not strand the job's chain, nor lose the rejections.
 *
 * `onError` is caller code -- a logger whose stream closed throws. While the cleanup ran
 * in a `then`, such a throw rejected the chain's own tail, so the entry was never
 * removed and the rejection surfaced unhandled. Both are invisible to a case that only
 * counts writes, which is why this one counts rejections too.
 */
async function throwingSinkKeepsChainUsable(): Promise<void> {
  const finished: number[] = [];
  const reports: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const registry = createDurableJobRegistry(createJobRegistry(), {
    db: refusingWritesTracked(finished),
    stackId: STACK,
    onError: (error) => {
      reports.push(error);
      throw new Error("the error sink itself is broken");
    },
  });
  const job = registry.create("note.md", new Date());
  registry.patchIngest(job.id, { status: "failed" }, new Date());
  registry.patchCompile(job.id, { status: "skipped" }, new Date());

  process.on("unhandledRejection", onUnhandled);
  try {
    await vi.waitFor(() => expect(finished).toHaveLength(3), { timeout: SETTLE_TIMEOUT_MS });
    // One macrotask past the last write, so Node has reported anything left unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  // Every failed write still reached the sink, and still in patch order: a throwing
  // sink neither silences the mirror nor reorders or cancels the job's writes.
  expect(reports).toHaveLength(3);
  expect(finished).toEqual([1, 2, 3]);
  // Nothing was left unhandled behind that sink, so no chain entry was stranded.
  expect(unhandled).toHaveLength(0);
}

describe("a job's mirror writes", () => {
  it("land in the order the patches happened, even when the first write is slowest", writesLandInPatchOrder);
  it("do not make one job wait for another job's write", jobsDoNotWaitForEachOther);
  it("report a failed write instead of swallowing it", failuresAreReportedAndSurvived);
  it("survive an error sink that throws, with nothing left unhandled", throwingSinkKeepsChainUsable);
});
