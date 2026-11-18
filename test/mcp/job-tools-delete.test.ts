/**
 * @file test/mcp/job-tools-delete.test.ts
 * @description S2 through the surface an agent actually calls: `ingest_job_delete`.
 *
 * WHY THE REGISTERED HANDLER AND REAL POSTGRES. The tool reads a durable row and deletes a
 * durable row, and both are decided inside the handler: no type proves that this release
 * registers the tool, refuses the job that is still working, or leaves a refused row alone.
 * So every case below calls the tool through the shared MCP fixture against a real
 * database, which is the same path an agent's `tools/call` takes.
 *
 * WHY THE REFUSALS ARE MEASURED IN BYTES. The reporter's complaint is that a stuck job could
 * not be cleared; the failure mode of "fixing" it is a delete that damages a row it refused
 * to delete. Each refusal case therefore compares the Stack's own rows as canonical text —
 * statuses, `updated_at` and the whole `jsonb` payload together — plus the count.
 *
 * The bound is pinned through the environment the tool reads, so a row stamped in the past
 * is stalled by construction; the "still working" case pins a bound long enough that a row
 * stamped now cannot cross it during the call.
 */
import { describe, expect, it } from "vitest";
import { saveIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { createProbeStack, type ProbeStack } from "../dimensions/harness-lifecycle.js";
import {
  ingestJobRows,
  runningJobRow,
  settledJobRow,
  useIngestJobSurface,
} from "../fixtures/ingest-job-rows.js";
import { buildServer, callTool, type McpToolEnvelope } from "../fixtures/mcp-test-env.js";

/** A job row left settled, untouched since an instant long gone. */
const SETTLED_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FE";

/** A job row still non-terminal by `isSettled`, silent since the same instant. */
const STALLED_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FF";

/** An id no Stack ever had. */
const UNKNOWN_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FG";

/** The last instant either stored row moved. Fixed, so nothing here reads the clock. */
const STAMP = "2020-01-01T00:00:00.000Z";

/** A one-second bound: any row stamped in the past is stalled by construction. */
const PAST_BOUND_MS = "1000";

/** An hour, so a row stamped NOW cannot cross the bound during a call. */
const WIDE_BOUND_MS = "3600000";

const surface = useIngestJobSurface("job-tools-delete", PAST_BOUND_MS);

/**
 * Store one row in this case's Stack.
 *
 * @param row - The snapshot to store.
 * @returns The Stack, or `undefined` when it never provisioned (the case then skips).
 */
async function seedJob(row: IngestJob): Promise<ProbeStack | undefined> {
  const stack = surface.stack();
  if (!stack.harness.reachable) return undefined;
  await saveIngestJob(stack.harness.db, stack.harness.stackId, row);
  return stack;
}

/** Call the delete tool against a freshly built server. */
async function deleteJob(jobId: string, stackId: string): Promise<McpToolEnvelope> {
  return await callTool(buildServer(surface.root()), "ingest_job_delete", { jobId, stackId });
}

/** Call the listing tool, returning the ids a caller would see. */
async function listedIds(stackId: string): Promise<string[]> {
  const envelope = await callTool(buildServer(surface.root()), "ingest_jobs_list", { stackId });
  const payload = envelope.structuredContent?.result as { jobs: { id: string }[] };
  return payload.jobs.map((job) => job.id);
}

/** The text a client branches on when a tool refuses. */
function textOf(envelope: McpToolEnvelope): string {
  return envelope.content.map((block) => block.text).join("");
}

describe("ingest_job_delete removes a job the policy allows", () => {
  it("deletes a settled job and it is gone from the listing", async () => {
    const stack = await seedJob(settledJobRow(SETTLED_JOB, STAMP));
    if (stack === undefined) return;

    const envelope = await deleteJob(SETTLED_JOB, stack.harness.stackId);

    expect(envelope.isError ?? false).toBe(false);
    expect(envelope.structuredContent?.result).toEqual({
      deleted: true,
      job: settledJobRow(SETTLED_JOB, STAMP),
    });
    expect(await ingestJobRows(stack.harness)).toEqual([]);
    expect(await listedIds(stack.harness.stackId)).toEqual([]);
  }, 60_000);

  it("deletes a job that stopped moving past the bound", async () => {
    const stack = await seedJob(runningJobRow(STALLED_JOB, STAMP));
    if (stack === undefined) return;

    const envelope = await deleteJob(STALLED_JOB, stack.harness.stackId);

    expect(envelope.isError ?? false).toBe(false);
    expect(await ingestJobRows(stack.harness)).toEqual([]);
  }, 60_000);
});

describe("ingest_job_delete refuses what it must not delete", () => {
  it("refuses a job that is still working and leaves its row byte-identical", async () => {
    surface.setBound(WIDE_BOUND_MS);
    const stack = await seedJob(runningJobRow(STALLED_JOB, new Date().toISOString()));
    if (stack === undefined) return;
    const before = await ingestJobRows(stack.harness);

    const envelope = await deleteJob(STALLED_JOB, stack.harness.stackId);

    expect(envelope.isError).toBe(true);
    expect(textOf(envelope)).toContain("is still working");
    expect(textOf(envelope)).toContain(STALLED_JOB);
    // Whole rows plus the count: a refusal that moved `updated_at` or rewrote the payload
    // would leave `count(*) = 1` and still be a damaged row.
    expect(await ingestJobRows(stack.harness)).toEqual(before);
    expect((await ingestJobRows(stack.harness)).length).toBe(1);
  }, 60_000);

  it("refuses an unknown id, names it, and changes no row", async () => {
    const stack = await seedJob(settledJobRow(SETTLED_JOB, STAMP));
    if (stack === undefined) return;
    const before = await ingestJobRows(stack.harness);

    const envelope = await deleteJob(UNKNOWN_JOB, stack.harness.stackId);

    expect(envelope.isError).toBe(true);
    expect(textOf(envelope)).toBe(`No ingest job '${UNKNOWN_JOB}' for this Stack.`);
    expect(await ingestJobRows(stack.harness)).toEqual(before);
  }, 60_000);
});

describe("ingest_job_delete is scoped to the Stack it names", () => {
  it("refuses a delete that names another Stack and leaves the owner's row alone", async () => {
    const stack = await seedJob(settledJobRow(SETTLED_JOB, STAMP));
    if (stack === undefined) return;
    const ownersRows = await ingestJobRows(stack.harness);
    const stranger = await createProbeStack("job-tools-delete-stranger");
    try {
      if (!stranger.harness.reachable) return;
      const strangersRows = await ingestJobRows(stranger.harness);

      const envelope = await deleteJob(SETTLED_JOB, stranger.harness.stackId);

      expect(envelope.isError).toBe(true);
      expect(textOf(envelope)).toBe(`No ingest job '${SETTLED_JOB}' for this Stack.`);
      expect(await ingestJobRows(stack.harness)).toEqual(ownersRows);
      expect(await ingestJobRows(stranger.harness)).toEqual(strangersRows);
    } finally {
      await stranger.harness.cleanup();
    }
  }, 60_000);
});
