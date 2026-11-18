/**
 * @file test/services/ingest-job-mirror-flush.test.ts
 * @description The bounded flush of the durable mirror's write chain, with no database.
 *
 * WHY THIS FILE EXISTS. The chain closes write ORDERING while the process lives. It does
 * not close SHUTDOWN DURABILITY: a process that exits right after settling can still
 * leave the pre-failure snapshot, and in a container a restart is routine. So the queue
 * must be flushable, and the flush must be BOUNDED — a shutdown that blocks forever on a
 * database that is gone is a worse failure than the one being fixed.
 *
 * The bound is proved with an injected timer seam, so neither case depends on how fast
 * the machine is: the case decides when the bound expires. That seam and the gated handle
 * are shared with the shutdown suites through
 * `test/fixtures/ingest-job-mirror-suite.ts`, so "the delays the flush scheduled" means
 * the same thing in every file that asserts it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createDurableJobRegistry,
  createIngestJobMirrorQueue,
  resolveMirrorFlushTimeoutMs,
} from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import { createJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import {
  INGEST_JOB_MIRROR_FLUSH_TIMEOUT_ENV_VAR,
  INGEST_JOB_MIRROR_FLUSH_TIMEOUT_MS_DEFAULT,
} from "../../packages/wiki/src/utils/constants.js";
import { controlledTimers, heldHandle } from "../fixtures/ingest-job-mirror-suite.js";

/** The Stack these jobs belong to; nothing here resolves it. */
const STACK = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** A bound that expires with one job still unwritten answers with that job id. */
async function unwrittenJobIdIsReported(): Promise<void> {
  const timers = controlledTimers();
  const queue = createIngestJobMirrorQueue({ timers });
  let openWrite = (): void => {};
  const held = new Promise<void>((resolve) => {
    openWrite = resolve;
  });
  queue.track("ing_held", () => held);

  let outcome: readonly string[] | undefined;
  const flushing = queue.flush(30_000).then((ids) => {
    outcome = ids;
    return ids;
  });
  await Promise.resolve();
  // Still waiting on the write, and the bound it was given is the one it scheduled --
  // not a magic number of its own.
  expect(outcome).toBeUndefined();
  expect(timers.delays).toEqual([30_000]);

  timers.expire();
  // The shutdown gets an answer it can report, naming what it left unwritten.
  expect(await flushing).toEqual(["ing_held"]);
  openWrite();
}

/** One queue flushes the pending writes of every wrapper sharing it. */
async function sharedQueueFlushesEveryWrapper(): Promise<void> {
  const queue = createIngestJobMirrorQueue();
  const held = heldHandle();
  const first = createDurableJobRegistry(createJobRegistry(), {
    db: held.db,
    stackId: STACK,
    queue,
  });
  const second = createDurableJobRegistry(createJobRegistry(), {
    db: held.db,
    stackId: STACK,
    queue,
  });
  // One host serves several Stacks from several wrappers over ONE database, so its
  // shutdown has to flush the queue rather than one wrapper at a time.
  first.create("first.md", new Date());
  second.create("second.md", new Date());
  // The chain issues its write on a microtask, so BOTH are open by now and neither can
  // land until the case releases the gate.
  await vi.waitFor(() => expect(held.entered()).toBe(2));

  const flushing = queue.flush(60_000);
  held.release();
  expect(await flushing).toEqual([]);
}

/** An environment carrying (or omitting) the flush-bound override. */
const envOf = (value: string | undefined): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [INGEST_JOB_MIRROR_FLUSH_TIMEOUT_ENV_VAR]: value };

/** Absent, empty, non-numeric, zero and negative all fall back to the named default. */
function defaultBoundIsUsed(): void {
  expect(resolveMirrorFlushTimeoutMs(envOf(undefined))).toBe(INGEST_JOB_MIRROR_FLUSH_TIMEOUT_MS_DEFAULT);
  for (const bad of ["", "   ", "5s", "0", "-1"]) {
    expect(resolveMirrorFlushTimeoutMs(envOf(bad))).toBe(INGEST_JOB_MIRROR_FLUSH_TIMEOUT_MS_DEFAULT);
  }
}

/** A positive override is read as milliseconds. */
function overrideIsUsed(): void {
  expect(resolveMirrorFlushTimeoutMs(envOf("250"))).toBe(250);
}

describe("flushing the mirror's write chain", () => {
  it("returns a job id it could not write once the bound expires", unwrittenJobIdIsReported);
  it("flushes the pending writes of every wrapper that shares it", sharedQueueFlushesEveryWrapper);
});

describe("the flush bound", () => {
  it("falls back to the named default when the override is absent or unusable", defaultBoundIsUsed);
  it("reads a positive override from the environment", overrideIsUsed);
});
