/**
 * @file packages/api/src/host/api-ingest-jobs-file-authority.test.ts
 * @description A settled job on a wiki with NO database carries no `dimensions` key, and
 * that absence is the honest answer rather than the silence this feature removed.
 *
 * ## Why the exception is pinned instead of described
 *
 * `docs/guides/http-ingest-jobs.mdx` says every settled job carries both entries *when the
 * run resolved dimensions*. The qualification is not decoration: `ingestAsFiles`
 * (`packages/wiki/src/services/ingest/service.ts`) writes `sources/<slug>.md` and performs NO
 * dimension commit, so there is no run state to report and the only way to fill the key would
 * be to invent a reason per dimension. A prose promise that every job carries the key would be
 * false on exactly this deployment, and prose is what got this feature's predecessor wrong.
 *
 * So the case is measured over the REAL route: a file-backed host, an async ingest, and a
 * settled job read back through `GET /api/ingest/jobs/:id`. The job must have SETTLED and
 * SUCCEEDED -- an absence on a failed job proves nothing about the file-authority mode.
 *
 * ## Why `compile: false`
 *
 * The compile half of a file-backed run is a separate capability with its own suites, and it
 * would add minutes to a case about a key that is absent. Omitting the compile leaves the
 * ingest half as the only subject, which is where the report would have come from.
 *
 * ## Why no database and no Docker
 *
 * The absence of a database IS the condition under test (S2 of the single-Stack authority:
 * "a wiki with no database at all is a legitimate mode"), so emptying `AKS_DATABASE_URL` is
 * the fixture. Nothing here provisions anything.
 */
import { describe, expect, it, vi } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { startHost } from "./server.js";
import { createJobRegistry } from "@repo/wiki/job-registry";
import { scratchProjectRoot } from "../../../../test/fixtures/host-scratch.js";

/** How often a poll re-reads the job it is waiting on. */
const POLL_MS = 20;

/** How long a poll waits for the detached ingest to settle before failing by name. */
const SETTLE_BUDGET_MS = 25_000;

/** Scratch projects this suite created, removed on teardown. */
const scratchRoots: string[] = [];

/**
 * A scratch project holding one readable source and the `sources/` directory the services
 * expect.
 *
 * @returns The project root, recorded for teardown.
 */
async function projectRoot(): Promise<string> {
  const root = await scratchProjectRoot("host-jobs-file-");
  scratchRoots.push(root);
  await writeFile(
    path.join(root, "note.md"),
    "# Note\n\nA sentence long enough that the ingest does not report short content.\n",
    "utf8",
  );
  return root;
}

/** The settled job body, read until both halves are terminal. */
interface SettledBody {
  readonly ingest: { readonly status: string };
  readonly compile: { readonly status: string };
  readonly [key: string]: unknown;
}

/**
 * The terminal test the poll waits on.
 *
 * `busy` and `skipped` are settled compile states, not pending ones, so they count; only
 * `queued` and `running` are still moving.
 *
 * @param body - A job read.
 * @returns Whether nothing further will change it.
 */
function isSettled(body: SettledBody): boolean {
  const ingestDone = body.ingest.status !== "running" && body.ingest.status !== "queued";
  const compileDone = body.compile.status !== "running" && body.compile.status !== "queued";
  return ingestDone && compileDone;
}

/**
 * Post one async ingest, without a compile, and return the job id it was accepted under.
 *
 * @param base - Origin of the running host.
 * @param source - Path of the readable source to ingest.
 * @returns The job id, after asserting the 202 that accepted it.
 */
async function acceptAsyncIngest(base: string, source: string): Promise<string> {
  const accepted = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, async: true, compile: false }),
  });
  // 202 means accepted, which is the contract this route keeps in every mode.
  expect(accepted.status).toBe(202);
  const { jobId } = (await accepted.json()) as { jobId: string };
  return jobId;
}

/**
 * Poll the job read until both halves are terminal, or fail naming the last body seen.
 *
 * @param base - Origin of the running host.
 * @param jobId - Job to read.
 * @returns The settled body.
 */
async function readSettledJob(base: string, jobId: string): Promise<SettledBody> {
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  let body: SettledBody | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/ingest/jobs/${jobId}`);
    expect(res.status).toBe(200);
    body = (await res.json()) as SettledBody;
    if (isSettled(body)) return body;
    await sleep(POLL_MS);
  }
  throw new Error(`job ${jobId} never settled within ${SETTLE_BUDGET_MS}ms: ${JSON.stringify(body)}`);
}

/**
 * Run one file-backed async ingest through the real routes and read the settled job back.
 *
 * @returns The settled body, after its host and scratch project are released.
 */
async function ingestInFileMode(): Promise<SettledBody> {
  const root = await projectRoot();
  const snapshot = await buildViewerSnapshot(root);
  const handle = await startHost({
    viewerSnapshot: snapshot, port: 0, projectRoot: root, ingestJobs: createJobRegistry(),
  });
  const base = `http://${handle.host}:${handle.port}`;
  try {
    return await readSettledJob(base, await acceptAsyncIngest(base, path.join(root, "note.md")));
  } finally {
    await handle.close();
    for (const scratch of scratchRoots.splice(0)) await rm(scratch, { recursive: true, force: true });
  }
}

describe("an async ingest on a wiki with no database", () => {
  it("settles succeeded with no dimensions key, because no dimension commit happened", async () => {
    // File authority is the ABSENCE of a database, and of every row-backed dimension that
    // could have reported one. Both names are emptied, not deleted, so the product's own
    // "a blank value is not configured" rule is what decides the mode.
    vi.stubEnv("AKS_DATABASE_URL", "");
    vi.stubEnv("AKS_STACK_ID", "");
    try {
      const body = await ingestInFileMode();

      // The run really happened and really succeeded: an absence on a FAILED job would prove
      // nothing about the file-authority mode, it would only prove the job broke.
      expect(body.ingest.status).toBe("succeeded");
      expect(body.compile.status).toBe("skipped");

      // The exception the guide now states. `in` rather than a value comparison, because a
      // `dimensions: []` or a `dimensions: undefined` would both be a claim; the claim this
      // mode must NOT make is that it reported on dimensions it never ran.
      expect("dimensions" in body).toBe(false);
      expect(Object.keys(body)).not.toContain("dimensions");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
