/**
 * @file packages/api/src/host/api-job-recovery.test.ts
 * @description S2, both halves: `DELETE /api/ingest/jobs/:jobId` clears a job an operator
 * cannot otherwise remove, and `POST /api/ingest/jobs/:jobId/retry` re-runs its source as a
 * NEW job. Every refusal leaves the stored rows BYTE-IDENTICAL and adds none.
 *
 * WHY THESE ASSERTIONS. "no hay manera de eliminarlo o que reintente" is answered by two
 * verbs over the public interface. The danger of answering it badly is a delete that also
 * removes a job which is still working — orphaning real work from its own status surface —
 * or a retry that "shows up" by resetting the old row, erasing what actually happened. So
 * the policy has to refuse on purpose, and a refusal has to be provably INERT.
 *
 * WHY WHOLE-ROW EQUALITY AND A ROW COUNT. A counter says nothing about an UPDATE: a refusal
 * that quietly rewrote `updated_at`, moved a status or rewrote the `jsonb` payload leaves
 * `count(*) = 1` before and after. Every refusal below is proved by the row's own canonical
 * text plus the count, which is the only form in which "nothing changed" is a literal claim.
 *
 * WHY THE RESURRECTION CASE EXISTS. `saveIngestJob` is an upsert. A mirror write still queued
 * for a job commits AFTER a naive delete and re-inserts the row — the reported hang with a
 * fresh timestamp, because the operator deletes it and it comes back. The delete therefore
 * drains that job's own chain first, and the case below holds one write open across the
 * request to prove it. Its RED was measured by disabling the drain: the row came back.
 *
 * THE BOUND IS THE NAMED ONE. Every case runs under a one-minute stuck bound, so "past the
 * bound" and "inside it" are facts of the stamps and not of how long the machine took.
 *
 * ONE FILE, TWO VERBS. Both routes answer the same envelopes for the same facts, and the
 * shared host here is what makes that comparable — a copy per verb could drive a host whose
 * registry and whose route drain different queues and still look right.
 */
import { describe, expect, it } from "vitest";
import type { IngestJob } from "@repo/wiki/job-types";
import {
  ingestJobRows,
  pause,
  recentStamp,
  rowsFor,
  runningJobRow,
  settledJobRow,
  silentStamp,
  storeRow,
  useIngestJobSurface,
} from "../../../../test/fixtures/ingest-job-rows.js";
import { withRecoveryHost, type RecoveryHost } from "./recovery-host.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";

/** A job id in the shape the registry mints. */
const JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FD";

/** A second job id, for the case that needs two rows to compare. */
const OTHER_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FE";

/** How long a case waits for the mirror chain to hand its writes to the database. */
const FLUSH_BOUND_MS = 10_000;

/** How long a held mirror write waits for the delete before letting its own write land. */
const RELEASE_BOUND_MS = 2_000;

/** The one-minute stuck bound every case here runs under. */
const surface = useIngestJobSurface("api-job-recovery", "60000");

/** Is the wiki schema reachable? A skip names the database rather than looking like a pass. */
const harnessReachable = await wikiReachable("api-job-recovery");

/**
 * Create a job through the host's own registry and drive it to a settled state.
 *
 * Settled through the registry rather than written as a literal so the case exercises the
 * live entry AND the mirrored row: a delete has to clear both.
 *
 * @param host - The running host.
 * @returns The job's id.
 */
async function settle(host: RecoveryHost): Promise<string> {
  const at = new Date();
  const job = host.registry.create("note.md", at);
  host.registry.patchIngest(job.id, { status: "unchanged", endedAt: at.toISOString() }, at);
  host.registry.patchCompile(job.id, { status: "skipped" }, at);
  await host.flush();
  return job.id;
}

/** A job that FAILED and is settled: the row a retry exists for. */
function failedSettledRow(): IngestJob {
  const stamp = silentStamp();
  return {
    ...settledJobRow(JOB, stamp),
    ingest: {
      status: "failed",
      endedAt: stamp,
      attempts: [],
      error: "ENOENT: no such file or directory, open 'note.md'",
    },
  };
}

/**
 * Drive one unknown-id request against a Stack holding `seed`, and assert nothing moved.
 *
 * Both recovery verbs answer the same envelope for the same fact, and neither may write on the
 * way to refusing — so the assertion is written once, against whichever verb is passed in.
 *
 * @param seed - The row the Stack already holds.
 * @param verb - The request the case makes.
 */
async function unknownIdRefused(
  seed: IngestJob,
  verb: (host: RecoveryHost, jobId: string) => Promise<Response>,
): Promise<void> {
  await withRecoveryHost(surface, async (host) => {
    const harness = surface.stack().harness;
    await storeRow(harness, seed);
    const before = await ingestJobRows(harness);

    const res = await verb(host, "ing_UNKNOWN");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "job_not_found", message: "No ingest job 'ing_UNKNOWN' for this Stack." },
    });
    expect(await ingestJobRows(harness)).toEqual(before);
  });
}

/**
 * The `job_still_working` refusal both verbs answer, read out of the envelope.
 *
 * One reader for one envelope: the delete and the retry refuse the same fact, and a case that
 * spelled the assertion twice could drift from the code that writes it.
 *
 * @param res - The refusal on the wire.
 * @returns Its message, so a case can check what it tells the caller to do.
 */
async function stillWorkingRefusalOf(res: Response): Promise<string> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("job_still_working");
  return body.error.message;
}

describe.skipIf(!harnessReachable)("DELETE /api/ingest/jobs/:jobId", () => {
  it("answers 200 for a settled job and leaves no row and no live entry", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      const jobId = await settle(host);
      expect(await rowsFor(harness, jobId)).toHaveLength(1);

      const res = await host.del(jobId);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true, jobId });
      expect(await rowsFor(harness, jobId)).toEqual([]);
      // The live entry too: a status surface still serving a deleted job is the same
      // inconsistency from the other side.
      expect(host.registry.get(jobId)).toBeUndefined();
    });
  }, 60_000);

  it("answers 200 for a job that stopped moving past the named bound", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      await storeRow(harness, runningJobRow(JOB, silentStamp()));

      const res = await host.del(JOB);

      expect(res.status).toBe(200);
      expect(await rowsFor(harness, JOB)).toEqual([]);
    });
  }, 60_000);

});

describe.skipIf(!harnessReachable)("the rows a delete refuses", () => {
  it("answers 409 for a job inside the bound and leaves its row byte-identical", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      await storeRow(harness, runningJobRow(JOB, recentStamp()));
      const before = await rowsFor(harness, JOB);

      const res = await host.del(JOB);

      // The message names both dimensions, so the caller can look the job up.
      expect(await stillWorkingRefusalOf(res)).toContain("ingest 'running', compile 'queued'");
      expect(await rowsFor(harness, JOB)).toEqual(before);
      expect(before).toHaveLength(1);
    });
  }, 60_000);

  it("answers 404 for an unknown id and changes no row", () =>
    unknownIdRefused(runningJobRow(JOB, silentStamp()), (host, id) => host.del(id)));
});

describe.skipIf(!harnessReachable)("the write that would resurrect a deleted row", () => {
  it("orders the delete behind that job's pending mirror write", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      const row = settledJobRow(JOB, silentStamp());
      await storeRow(harness, row);
      // A mirror write still queued for THIS job, held open across the delete. Released, it
      // re-inserts exactly the row the delete removes — the upsert is why the hazard is real.
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      host.queue.track(JOB, async () => {
        await gate;
        await storeRow(harness, row);
      });

      const deletion = host.del(JOB);
      // Either the delete answers (it did NOT wait for the write, so the write will land after
      // it) or the bound expires (it IS waiting, which is what this case wants).
      await Promise.race([deletion.then(() => undefined, () => undefined), pause(RELEASE_BOUND_MS)]);
      release();
      const res = await deletion;

      expect(res.status).toBe(200);
      await host.flush();
      // NOT resurrected: this is the whole assertion.
      expect(await rowsFor(harness, JOB)).toEqual([]);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("the delete and the status route agree", () => {
  it("deletes exactly the row the status route reports as stalled", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      const stalled = runningJobRow(JOB, silentStamp());
      const fresh = runningJobRow(OTHER_JOB, recentStamp());
      await storeRow(harness, stalled);
      await storeRow(harness, fresh);

      const stalledRead = await host.read(stalled.id);
      const freshRead = await host.read(fresh.id);
      expect(stalledRead.status).toBe(200);
      // The read DERIVES the stall from the same bound the delete compares against...
      expect((await stalledRead.json()).stalledSince).toBe(stalled.updatedAt);
      expect(freshRead.status).toBe(200);
      expect(await freshRead.json()).not.toHaveProperty("stalledSince");

      // ...and the two surfaces cannot drift: the row the read calls stalled is the row the
      // delete accepts, and the row it does not call stalled is the row the delete refuses.
      expect((await host.del(stalled.id)).status).toBe(200);
      expect((await host.del(fresh.id)).status).toBe(409);
      expect(await rowsFor(harness, fresh.id)).toHaveLength(1);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("POST /api/ingest/jobs/:jobId/retry", () => {
  it("answers 202 with a NEW job id and leaves the original row byte-identical", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      await storeRow(harness, failedSettledRow());
      const before = await rowsFor(harness, JOB);

      const res = await host.retry(JOB);

      expect(res.status).toBe(202);
      const accepted = (await res.json()) as { jobId: string; stage: string };
      // A NEW job: the retry is a fresh run, not a reset of the old row.
      expect(accepted.jobId).not.toBe(JOB);
      expect(accepted.jobId.startsWith("ing_")).toBe(true);
      expect(accepted.stage).toBe("queued");
      await host.flush();
      // THE RULE: unchanged state, unchanged counters, unchanged payload.
      expect(await rowsFor(harness, JOB)).toEqual(before);
      // And the retry really did enqueue work: its own row exists beside the original.
      expect(await rowsFor(harness, accepted.jobId)).toHaveLength(1);
      expect(await ingestJobRows(harness)).toHaveLength(2);
      expect(host.registry.get(accepted.jobId)?.source).toBe("note.md");
    });
  }, 60_000);

});

describe.skipIf(!harnessReachable)("refusing a retry", () => {
  it("answers 409 for a job inside the bound, storing nothing new", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      // Non-terminal and silent for less than the bound: this job may be running RIGHT NOW,
      // which is the row a retry must not double.
      await storeRow(harness, runningJobRow(JOB, recentStamp()));
      const before = await ingestJobRows(harness);

      const res = await host.retry(JOB);

      expect(await stillWorkingRefusalOf(res)).toContain("so it was not retried");
      // No state moved and NOTHING was enqueued: a refused retry must not leave a job.
      expect(await ingestJobRows(harness)).toEqual(before);
      expect(before).toHaveLength(1);
    });
  }, 60_000);

  it("answers 404 for an unknown id and enqueues nothing", () =>
    unknownIdRefused(failedSettledRow(), (host, id) => host.retry(id)));
});

describe.skipIf(!harnessReachable)("the routes this change sits beside", () => {
  it("still serves the job read and still accepts an async ingest", async () => {
    await withRecoveryHost(surface, async (host) => {
      const jobId = await settle(host);

      // PRESERVE: the GET route is untouched by a DELETE appearing on the same prefix.
      const read = await host.read(jobId);
      expect(read.status).toBe(200);
      expect((await read.json()).id).toBe(jobId);

      // PRESERVE: the accepted-ingest route still answers 202 with a tracked job.
      const accepted = await host.post({ source: "not-a-real-source", async: true });
      expect(accepted.status).toBe(202);
      expect(((await accepted.json()) as { jobId: string }).jobId.startsWith("ing_")).toBe(true);
    });
  }, 60_000);
});
