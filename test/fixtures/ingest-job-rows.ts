/**
 * @file test/fixtures/ingest-job-rows.ts
 * @description The job snapshots the delete suites store, the byte view of a Stack's rows,
 * and the surface lifecycle an MCP job-tool suite needs.
 *
 * WHY SHARED. Two suites ask the same two questions — "does a settled row go?" and "does a
 * row that is still working stay?" — one through the jobs layer and one through the MCP tool.
 * The stored payloads and the row-as-text view therefore have to be the SAME values in both
 * files, or the two answers are about two different rows.
 *
 * NO ASSERTIONS LIVE HERE: these helpers only put the code under test into the state a case
 * wants, and hand back what the database holds.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach } from "vitest";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { INGEST_JOB_STUCK_AFTER_ENV_VAR } from "../../packages/wiki/src/utils/constants.js";
import { saveIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import { createProbeStack, type ProbeStack } from "../dimensions/harness-lifecycle.js";
import { createEnvSnapshot } from "./env-snapshot.js";
import { scratchProjectRoot } from "./host-scratch.js";
import type { KgPostgresHarness } from "./kg-postgres.js";
import { snapshotTenantRows } from "./tenant-snapshot.js";

/**
 * A settled job: the ingest finished and the compile was skipped, so nothing can move again.
 *
 * @param id - The job id to store.
 * @param stamp - The instant it was created and last moved.
 * @returns The snapshot.
 */
export function settledJobRow(id: string, stamp: string): IngestJob {
  return {
    id,
    source: "note.md",
    createdAt: stamp,
    updatedAt: stamp,
    ingest: { status: "unchanged", endedAt: stamp, attempts: [], message: "Content unchanged." },
    compile: { status: "skipped", progress: null, message: "Compile skipped on request." },
  };
}

/**
 * A job that is still non-terminal by `isSettled`.
 *
 * @param id - The job id to store.
 * @param stamp - The instant it was created and last moved. Past the bound, this is the
 *   stuck row the reporter could not clear; recent, it is the job a delete must protect.
 * @returns The snapshot.
 */
export function runningJobRow(id: string, stamp: string): IngestJob {
  return {
    id,
    source: "note.md",
    createdAt: stamp,
    updatedAt: stamp,
    ingest: { status: "running", stage: "fetching", attempts: [] },
    compile: { status: "queued", progress: null },
  };
}

/**
 * Every row a Stack owns in `wiki.ingest_job`, as canonical text.
 *
 * The whole row — statuses, `updated_at` and the `jsonb` payload — so "nothing changed" is a
 * byte claim rather than a counter that an UPDATE leaves untouched.
 *
 * @param harness - A handle on the database the Stack lives in.
 * @param stackId - The ONE tenant to read; defaults to the harness's own.
 * @returns One string per row, ordered by the row's serialized text.
 */
export async function ingestJobRows(
  harness: KgPostgresHarness,
  stackId: string = harness.stackId,
): Promise<readonly string[]> {
  const snapshot = await snapshotTenantRows(harness, stackId);
  return snapshot["wiki.ingest_job"] ?? [];
}

/** A probe Stack, a scratch project root, and the stuck bound the tool reads. */
export interface IngestJobSurface {
  /** Project root the server is built against, for the current case. */
  root(): string;
  /** The Stack this case owns. */
  stack(): ProbeStack;
  /** Re-pin the stuck bound, for a case that needs a different window. */
  setBound(boundMs: string): void;
}

/**
 * Install the lifecycle one MCP job-tool suite repeats: a scratch root, a fresh Stack, and
 * the bound handed to the tools through the environment they read.
 *
 * @param label - Short suite name; it also prefixes the scratch root.
 * @param boundMs - The stuck bound every case reads unless it re-pins one.
 * @returns Accessors for the root, the Stack, and the bound.
 */
export function useIngestJobSurface(label: string, boundMs: string): IngestJobSurface {
  const env = createEnvSnapshot([
    "AKS_STACK_ID",
    "AKS_DATABASE_URL",
    INGEST_JOB_STUCK_AFTER_ENV_VAR,
  ]);
  let root = "";
  let probe: ProbeStack | undefined;

  beforeEach(async () => {
    root = await scratchProjectRoot(`${label}-`);
    probe = await createProbeStack(label);
    env.setEnv({ ...probe.env(), [INGEST_JOB_STUCK_AFTER_ENV_VAR]: boundMs });
  });

  afterEach(async () => {
    env.restore();
    await probe?.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root: () => root,
    stack: () => {
      if (probe === undefined) {
        throw new Error("useIngestJobSurface installs its Stack per case; read it inside a test");
      }
      return probe;
    },
    setBound: (next) => env.setEnv({ ...probe?.env(), [INGEST_JOB_STUCK_AFTER_ENV_VAR]: next }),
  };
}

/** Store one row directly, for a job the live registry does not hold. */
export async function storeRow(harness: KgPostgresHarness, job: IngestJob): Promise<void> {
  await saveIngestJob(harness.db, harness.stackId, job);
}

/**
 * The canonical text of the rows for ONE job id, and nothing else.
 *
 * @param harness - The suite's Stack.
 * @param jobId - The job whose rows are compared.
 * @returns One string per matching row, ordered by the row's serialized text.
 */
export async function rowsFor(
  harness: KgPostgresHarness,
  jobId: string,
): Promise<readonly string[]> {
  return (await ingestJobRows(harness)).filter((row) => row.includes(jobId));
}

/** An instant far enough in the past to be past a one-minute stuck bound. */
export function silentStamp(): string {
  return new Date(Date.now() - 10 * 60_000).toISOString();
}

/** An instant inside a one-minute stuck bound: the job may be running right now. */
export function recentStamp(): string {
  return new Date().toISOString();
}

/**
 * A timer that does nothing but end, used to bound a wait a case cannot otherwise bound.
 *
 * @param ms - How long to wait.
 * @returns A promise that resolves after `ms`.
 */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
