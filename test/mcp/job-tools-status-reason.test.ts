/**
 * @file test/mcp/job-tools-status-reason.test.ts
 * @description The MCP job tools must explain a job too — proven by calling them.
 *
 * WHY THIS FILE EXISTS. The status reason was added to a shared module and wired into two
 * surfaces. The viewer route is proven by `test/viewer/api-ingest-jobs-status.test.ts`;
 * types prove nothing about the MCP side, because the wiring is one call inside each
 * handler. So these cases drive the registered tools against real Postgres: an agent
 * reading a job over MCP is the caller who polled a hung job and got "running", and this
 * file is the only proof that it now gets an answer.
 *
 * The bound is pinned to ONE SECOND through the environment the tools read, so a row
 * stamped in the past is stalled by construction. The consequence is that nothing here
 * waits, and nothing here depends on how long the machine takes.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import { abandonedSnapshotOf } from "../../packages/wiki/src/services/ingest/jobs/reaper.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { INGEST_JOB_STUCK_AFTER_ENV_VAR } from "../../packages/wiki/src/utils/constants.js";
import { createProbeStack, type ProbeStack } from "../dimensions/harness-lifecycle.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { buildServer, callTool, type McpToolEnvelope } from "../fixtures/mcp-test-env.js";

/** A row left mid-ingest, untouched since a fixed instant long gone. */
const STALE_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FB";

/** A row stored exactly as the pre-change code left it: settled, with none of the new fields. */
const SETTLED_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FC";

/** The last instant either row moved. Fixed, so no assertion depends on the wall clock. */
const STAMP = "2020-01-01T00:00:00.000Z";

/** The bound these tools are told to use, in milliseconds. */
const BOUND_MS = "1000";

/** The instant a reap happened: after the row's last real movement, which it quotes. */
const REAPED_AT = "2020-01-02T00:00:00.000Z";

let stack: ProbeStack;
let root: string;
const env = createEnvSnapshot(["AKS_STACK_ID", "AKS_DATABASE_URL", INGEST_JOB_STUCK_AFTER_ENV_VAR]);

beforeEach(async () => {
  root = await scratchProjectRoot("job-tools-reason-");
  stack = await createProbeStack("job-tools-reason");
  env.setEnv({ ...stack.env(), [INGEST_JOB_STUCK_AFTER_ENV_VAR]: BOUND_MS });
});

afterEach(async () => {
  env.restore();
  await stack.harness.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** A row that is still non-terminal by `isSettled`, and silent for years. */
function staleRunningJob(): IngestJob {
  return {
    id: STALE_JOB,
    source: "note.md",
    createdAt: STAMP,
    updatedAt: STAMP,
    ingest: { status: "running", stage: "fetching", attempts: [] },
    compile: { status: "queued", progress: null },
  };
}

/** A settled row with neither `statusReason` nor `compile.retryable`, as stored before. */
function oldShapeJob(): IngestJob {
  return {
    id: SETTLED_JOB,
    source: "stale-note.md",
    createdAt: STAMP,
    updatedAt: STAMP,
    ingest: {
      status: "unchanged",
      endedAt: STAMP,
      attempts: [],
      message: "Content unchanged; nothing was written.",
    },
    compile: { status: "skipped", progress: null, message: "Compile skipped on request." },
  };
}

/** Call one job tool against a freshly built server. */
async function call(args: {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}): Promise<McpToolEnvelope> {
  return await callTool(buildServer(root), args.name, args.arguments);
}

/**
 * Read one job through `ingest_job_status` on a freshly built server.
 *
 * @param jobId - The job asked for, in this case's Stack.
 * @returns The payload the tool answered with.
 */
async function statusOf(jobId: string): Promise<Record<string, unknown>> {
  return resultOf(await call({
    name: "ingest_job_status",
    arguments: { jobId, stackId: stack.harness.stackId },
  }));
}

/** The payload a tool answered with, or a failure naming the envelope. */
function resultOf(envelope: McpToolEnvelope): Record<string, unknown> {
  expect(envelope.isError ?? false).toBe(false);
  return envelope.structuredContent?.result as Record<string, unknown>;
}

describe("ingest_job_status over MCP", () => {
  it("explains a stalled row with a derived reason and the instant it stopped", async () => {
    if (!stack.harness.reachable) return;
    await saveIngestJob(stack.harness.db, stack.harness.stackId, staleRunningJob());

    const job = await statusOf(STALE_JOB);

    expect(job.statusReason).toEqual({
      reason: `no progress since ${STAMP}; the owning process may have stopped`,
      kind: "derived",
    });
    expect(job.stalledSince).toBe(STAMP);
  }, 60_000);

  it("adds nothing at all to a row stored before these fields existed", async () => {
    if (!stack.harness.reachable) return;
    const payload = oldShapeJob();
    await saveIngestJob(stack.harness.db, stack.harness.stackId, payload);

    const job = await statusOf(SETTLED_JOB);

    // Deep-equality against the payload that was written: an agent reading an old row must
    // see that row, not this release's idea of one.
    expect(job).toEqual(payload);
  }, 60_000);
});

describe("a row the reaper settled, over MCP", () => {
  it("reports a reaped row's conclusion as DERIVED, on the tool an agent actually calls", async () => {
    if (!stack.harness.reachable) return;
    // The payload is the REAPER's own, so the marker and the sentence are the writer's.
    await saveIngestJob(
      stack.harness.db,
      stack.harness.stackId,
      abandonedSnapshotOf(staleRunningJob(), REAPED_AT),
    );

    const job = await statusOf(STALE_JOB);

    expect(job.statusReason).toEqual({
      reason: `abandoned: no update since ${STAMP}; the process that owned it stopped`,
      kind: "derived",
    });
    expect(job.abandonedAt).toBe(REAPED_AT);
    expect(job).not.toHaveProperty("stalledSince");
  }, 60_000);

});

describe("ingest_jobs_list over MCP", () => {
  it("keeps the count and explains the stalled row in the listing", async () => {
    if (!stack.harness.reachable) return;
    await saveIngestJob(stack.harness.db, stack.harness.stackId, staleRunningJob());
    await saveIngestJob(stack.harness.db, stack.harness.stackId, oldShapeJob());

    const listed = resultOf(await call({
      name: "ingest_jobs_list",
      arguments: { stackId: stack.harness.stackId },
    })) as { jobs: { id: string; statusReason?: { kind: string } }[]; count: number };

    expect(listed.count).toBe(2);
    expect(listed.count).toBe(listed.jobs.length);
    // One rule, both tools: the mapping this release added must run over the listing too.
    expect(listed.jobs.find((entry) => entry.id === STALE_JOB)?.statusReason?.kind).toBe("derived");
    expect(listed.jobs.find((entry) => entry.id === SETTLED_JOB)).not.toHaveProperty("statusReason");
  }, 60_000);
});
