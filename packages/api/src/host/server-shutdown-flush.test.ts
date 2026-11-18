/**
 * @file packages/api/src/host/server-shutdown-flush.test.ts
 * @description `HostHandle.close()` is where a pending job mirror write stops being lost.
 *
 * WHY THIS FILE EXISTS. The chain closes write ORDER while the process lives; it does not close
 * SHUTDOWN DURABILITY. `HostHandle.close()` is the ONE close path — the signal handler registers
 * it (`main.ts` → `registerShutdown(handle.close)`) and tests call it — so wiring the bounded
 * flush there is what makes a restart unable to freeze the pre-failure snapshot in
 * `wiki.ingest_job`, which is the reported symptom by a third road.
 *
 * WHY IT LIVES BESIDE `server.ts`. A `test/` file may not reach into `packages/api/src`, and the
 * convention for this module is already its own directory (`api-ingest-jobs.test.ts`,
 * `tenant-routing.test.ts`). So the wiring is proved from here, importing `./server.js` the way
 * every sibling does.
 *
 * Every case drives the bound through the queue's injected timer seam: the case decides when the
 * bound expires, so nothing here depends on how fast the machine is. The write is held open by
 * the database handle for the same reason.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import {
  createDurableJobRegistry,
  createIngestJobMirrorQueue,
  type IngestJobMirrorQueue,
} from "@repo/wiki/job-durable-registry";
import { readIngestJob } from "@repo/wiki/job-store";
import { createJobRegistry, isSettled } from "@repo/wiki/job-registry";
import { createKgPostgresHarness, type KgPostgresHarness } from "../../../../test/fixtures/kg-postgres.js";
import { useFileMode } from "../../../../test/fixtures/file-mode.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";
import {
  controlledTimers,
  heldHandle,
  settleJobToTerminal,
  TERMINAL_ERROR,
  type ControlledTimers,
  type HeldHandle,
} from "../../../../test/fixtures/ingest-job-mirror-suite.js";
import { startHost } from "./server.js";

useFileMode();

/** The bound the host is told to use; it reaches the queue through the environment. */
const BOUND_MS = 250;

const harnessReachable = await wikiReachable("host-shutdown");

/** A started host plus everything a case inspects about it. */
interface WiredHost {
  readonly close: () => Promise<void>;
  readonly harness: KgPostgresHarness;
  readonly jobId: string;
  readonly held: HeldHandle;
  readonly timers: ControlledTimers;
  readonly flushes: () => number;
  readonly registry: ReturnType<typeof createDurableJobRegistry>;
}

/**
 * A queue on the controlled seam that counts how many times the host flushed it.
 *
 * @param timers - The seam every flush must schedule on.
 * @returns The queue and its counter.
 */
function countedQueue(timers: ControlledTimers): { queue: IngestJobMirrorQueue; flushes: () => number } {
  const inner = createIngestJobMirrorQueue({ timers });
  let flushes = 0;
  return {
    queue: {
      track: (jobId, write) => inner.track(jobId, write),
      // Forwarded, not counted: the delete's per-job drain is not a flush, and a decorator that
      // dropped it would leave the host ordering nothing behind its own mirror writes.
      drainJob: (jobId, timeoutMs) => inner.drainJob(jobId, timeoutMs),
      flush: (timeoutMs) => {
        flushes += 1;
        return inner.flush(timeoutMs);
      },
    },
    flushes: () => flushes,
  };
}

/**
 * Start a host whose job registry mirrors through a gated handle, then settle one job.
 *
 * @param harness - The Stack's database.
 * @returns The host's close, the job, and the handles a case inspects.
 */
async function wiredHost(harness: KgPostgresHarness): Promise<WiredHost> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-shutdown-")));
  const timers = controlledTimers();
  const counted = countedQueue(timers);
  const held = heldHandle(harness.db);
  const registry = createDurableJobRegistry(createJobRegistry(), {
    db: held.db,
    stackId: harness.stackId,
    queue: counted.queue,
  });
  const handle = await startHost({
    viewerSnapshot: await buildViewerSnapshot(root),
    port: 0,
    includeGraph: false,
    ingestJobs: registry,
    jobMirrorQueue: counted.queue,
  });
  const jobId = settleJobToTerminal(registry);
  return { close: handle.close, harness, jobId, held, timers, flushes: counted.flushes, registry };
}

/**
 * Run one case against a fresh Stack whose host is wired to a gated handle.
 *
 * The two facts every case depends on before it can assert anything are established
 * here, once: the bound the host resolves from the environment, and the first write
 * being open. A case that never saw the write open would otherwise be measuring a
 * different moment than the one it names.
 *
 * @param label - Suite label for the Stack, so a leaked one is traceable to its case.
 * @param body - The case, given the started host.
 */
async function withWiredHost(
  label: string,
  body: (wired: WiredHost) => Promise<void>,
): Promise<void> {
  process.env.LLMWIKI_INGEST_JOB_FLUSH_TIMEOUT_MS = String(BOUND_MS);
  const harness = await createKgPostgresHarness(`host-shutdown-${label}-${Date.now()}`);
  try {
    const wired = await wiredHost(harness);
    await vi.waitFor(() => expect(wired.held.entered()).toBe(1));
    await body(wired);
  } finally {
    await harness.cleanup();
  }
}

/** Row 1: the close waits for the held write and the row it leaves behind is terminal. */
async function terminalRowAfterClose(): Promise<void> {
  await withWiredHost("await", async (wired) => {
    // Nothing durable yet: this is the state a process exit would freeze.
    expect(await readIngestJob(wired.harness.db, wired.harness.stackId, wired.jobId)).toBeUndefined();

    const closing = wired.close();
    wired.held.release();
    await closing;

    // The WHOLE chain landed before close() resolved, not only the write that was open: the
    // remaining two are issued only after their predecessor settles, so a close that did not
    // await the flush would resolve with this still at 1.
    expect(wired.held.entered()).toBe(3);
    const stored = await readIngestJob(wired.harness.db, wired.harness.stackId, wired.jobId);
    // The TERMINAL snapshot, not the pre-failure one.
    expect(stored).toEqual(wired.registry.get(wired.jobId));
    expect(stored !== undefined && isSettled(stored)).toBe(true);
    expect(stored?.ingest.error).toBe(TERMINAL_ERROR);
  });
}

/** Row 2: a write that never lands cannot hang the close, and its job id is reported. */
async function boundedCloseNamesUnwrittenJob(): Promise<void> {
  const reported: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    reported.push(String(chunk));
    return true;
  });
  try {
    await withWiredHost("hang", async (wired) => {
      const closing = wired.close();
      await vi.waitFor(() => expect(wired.flushes()).toBe(1));

      // Still waiting: only the bound can end this, and the write is never released.
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);

      wired.timers.expire();
      await closing;

      // The bound the host resolved from the environment is the one the queue scheduled.
      expect(wired.timers.delays).toEqual([BOUND_MS]);
      // Named, not counted: an operator has to be able to find the row.
      expect(reported.join("")).toContain(wired.jobId);
    });
  } finally {
    vi.restoreAllMocks();
  }
}

/** Row 3: a second close flushes nothing again and does not wait again. */
async function secondCloseIsInert(): Promise<void> {
  await withWiredHost("idem", async (wired) => {
    const first = wired.close();
    wired.held.release();
    await first;

    // A second close is what a signal handler plus a test produce.
    const second = wired.close();
    await expect(second).resolves.toBeUndefined();
    expect(wired.flushes()).toBe(1);
    expect(second).toBe(first);
  });
}

describe.skipIf(!harnessReachable)("closing a host with a pending job mirror write", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_INGEST_JOB_FLUSH_TIMEOUT_MS;
  });

  it("awaits the held write, so the row is the TERMINAL snapshot after close", terminalRowAfterClose);
  it("returns inside the bound and reports the job id it left unwritten", boundedCloseNamesUnwrittenJob);
  it("flushes once and does not wait again on a second close", secondCloseIsInert);
});
