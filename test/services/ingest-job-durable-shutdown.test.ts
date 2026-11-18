/**
 * @file test/services/ingest-job-durable-shutdown.test.ts
 * @description A pending mirror write is AWAITED on close, so a restart cannot lose it.
 *
 * THE DEFECT THESE CASES PIN. The write chain closes ordering, not shutdown durability: a
 * process that exits right after settling can leave `wiki.ingest_job` holding the
 * pre-failure snapshot, because the terminal write is queued and nothing awaited it. In a
 * container a restart is routine, so the operator finds `running`/`queued` with a frozen
 * `updated_at` and no error — the reported symptom by a third road.
 *
 * The write is HELD OPEN by the handle, not delayed by a sleep: the case releases it at the
 * moment it chooses, so "the flush awaited it" is a fact rather than a race outcome. The
 * gate itself lives in `test/fixtures/ingest-job-mirror-suite.ts`, shared with the host's
 * close suite; it wraps the REAL handle, which is what lets this case read the row while
 * the write is still open.
 */
import { describe, expect, it, vi } from "vitest";
import { createDurableJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import { readIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import { createJobRegistry, isSettled } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import {
  heldHandle,
  settleJobToTerminal,
  TERMINAL_ERROR,
} from "../fixtures/ingest-job-mirror-suite.js";
import { withStack, wikiReachable } from "../fixtures/stack-harness.js";

/** Generous bound for the awaited case; the write is released by the case itself. */
const AWAIT_BOUND_MS = 60_000;

const harnessReachable = await wikiReachable("job-shutdown");

describe.skipIf(!harnessReachable)("closing the durable job mirror", () => {
  it("awaits the held write, so the stored row is the TERMINAL snapshot", async () => {
    await withStack("job-shutdown-await", async (harness) => {
      const held = heldHandle(harness.db);
      const registry = createDurableJobRegistry(createJobRegistry(), {
        db: held.db,
        stackId: harness.stackId,
      });
      const jobId = settleJobToTerminal(registry);
      // One write is open and the other two are queued behind it: nothing is durable yet,
      // which is exactly the state a process exit would freeze.
      await vi.waitFor(() => expect(held.entered()).toBe(1));
      expect(await readIngestJob(harness.db, harness.stackId, jobId)).toBeUndefined();

      const flushing = registry.flushMirror(AWAIT_BOUND_MS);
      // A flush that answered "nothing pending" would resolve here; a flush that WAITS on
      // the held write cannot. This is the assertion the pipe-empty version fails.
      let answered = false;
      void flushing.then(() => {
        answered = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(answered).toBe(false);
      expect(await readIngestJob(harness.db, harness.stackId, jobId)).toBeUndefined();

      held.release();

      // Nothing was left unwritten, so the close reported nothing to the operator.
      expect(await flushing).toEqual([]);
      // The whole chain landed, not only the write that happened to be open.
      expect(held.entered()).toBe(3);
      const stored = await readIngestJob(harness.db, harness.stackId, jobId);
      // The TERMINAL snapshot, not the pre-failure one the row would have kept.
      expect(stored).toEqual(registry.get(jobId));
      expect(stored !== undefined && isSettled(stored)).toBe(true);
      expect(stored?.ingest.error).toBe(TERMINAL_ERROR);
    });
  });
});
