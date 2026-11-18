/**
 * @file test/services/ingest-job-mirror-drain.test.ts
 * @description Draining ONE job's mirror chain: the ordering a delete needs, and the bound
 * it must never hang on.
 *
 * WHY THIS METHOD EXISTS. The mirror chain orders a job's writes while the process lives.
 * It does not know that a DELETE is about to remove that job's row — and `saveIngestJob` is
 * an upsert, so a write still queued for that job lands AFTER the row is gone and INSERTS
 * it again. The row comes back, which is the reported symptom with a new timestamp. So the
 * delete has to wait for that job's own chain first, and the queue is the only thing that
 * knows how long it is.
 *
 * WHY PER JOB, NOT `flush`. A flush waits for every job the host is mirroring. A delete of
 * one row must not be held hostage by an unrelated job's slow write, and a surface that
 * waited for all of them would turn one slow job into "recovery is broken".
 *
 * The bound is proved with the injected timer seam from
 * `test/fixtures/ingest-job-mirror-suite.ts`, so no case here depends on how fast the
 * machine is: the case decides when the bound expires.
 */
import { describe, expect, it, vi } from "vitest";
import { createIngestJobMirrorQueue } from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import { controlledTimers, type ControlledTimers } from "../fixtures/ingest-job-mirror-suite.js";

/** The job whose chain is drained. */
const JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0F1";

/** A second job, so a case can prove the drain is per job and not per queue. */
const OTHER = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0F2";

/** A write that stays open until the case releases it. */
interface HeldWrite {
  readonly write: () => Promise<void>;
  release(): void;
  landed(): boolean;
}

/**
 * Build a write the case can hold open and release by hand.
 *
 * @returns The thunk, its release, and whether it has run to completion.
 */
function heldWrite(): HeldWrite {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let done = false;
  return {
    write: async () => {
      await gate;
      done = true;
    },
    release: () => open(),
    landed: () => done,
  };
}

/** A queue with one held write for {@link JOB}, and the drain already waiting on it. */
async function drainOverHeldWrite(): Promise<{
  timers: ControlledTimers;
  held: HeldWrite;
  draining: Promise<boolean>;
}> {
  const timers = controlledTimers();
  const queue = createIngestJobMirrorQueue({ timers });
  const held = heldWrite();
  queue.track(JOB, held.write);
  const draining = queue.drainJob(JOB, 30_000);
  // It scheduled the bound it was given and is still waiting: the pending write is what it is
  // waiting for, which is the whole difference between this and a flush.
  await vi.waitFor(() => expect(timers.delays).toEqual([30_000]));
  return { timers, held, draining };
}

describe("draining one job's mirror chain", () => {
  it("answers at once when nothing is queued for that job", async () => {
    // The flush bound never expires here: an implementation that waited for the timer
    // instead of for the chain would hang, so an answer is the assertion.
    const queue = createIngestJobMirrorQueue({ timers: controlledTimers() });
    await expect(queue.drainJob(JOB, 30_000)).resolves.toBe(true);
  });

  it("is not held by another job's pending write", async () => {
    const queue = createIngestJobMirrorQueue({ timers: controlledTimers() });
    const unrelated = heldWrite();
    queue.track("ing_other_held", unrelated.write);
    // This job's own write resolves immediately, so its chain is free.
    queue.track(JOB, async () => {});

    await expect(queue.drainJob(JOB, 30_000)).resolves.toBe(true);
    // A `flush` would still be waiting here; that is exactly why the delete does not use it.
    expect(unrelated.landed()).toBe(false);
    unrelated.release();
  });

  it("waits for that job's own write and answers true once it landed", async () => {
    const { held, draining } = await drainOverHeldWrite();
    expect(held.landed()).toBe(false);

    held.release();
    await expect(draining).resolves.toBe(true);
    expect(held.landed()).toBe(true);
  });
});

describe("the drain's bound, and the flush beside it", () => {
  it("answers false when its bound expires with the write still open", async () => {
    const { timers, held, draining } = await drainOverHeldWrite();
    timers.expire();

    // A caller that is told this cannot claim the row is clear; the write is still out
    // there and can still land.
    await expect(draining).resolves.toBe(false);
    expect(held.landed()).toBe(false);
    held.release();
  });

  it("does not disturb the flush it shares a queue with", async () => {
    // PRESERVE: the shutdown flush still waits for EVERY job's chain, including the one a
    // drained delete already saw land.
    const queue = createIngestJobMirrorQueue();
    const first = heldWrite();
    const second = heldWrite();
    queue.track(JOB, first.write);
    queue.track(OTHER, second.write);

    const flushed = queue.flush(60_000);
    first.release();
    second.release();

    await expect(queue.drainJob(JOB, 30_000)).resolves.toBe(true);
    await expect(flushed).resolves.toEqual([]);
  });
});
