/**
 * @file test/services/ingest-job-run.test.ts
 * @description A failed job must TELL you it failed, in both places that matter.
 *
 * WHY THESE ASSERTIONS. A job that silently stops transitioning is worse than no
 * job at all: the UI polls forever and the operator learns nothing. So the two
 * things pinned here are the ones a user actually acts on:
 *
 *   1. A settle always records WHY, on the dimension that failed.
 *   2. A failure is durable. The in-memory job dies with the process -- accepted --
 *      but "why did this upload never appear" must survive a restart, which is what
 *      the `.llmwiki/ingest-failures.jsonl` record is for.
 *
 * These run without a database: the failure path is exercised by handing the job a
 * source that cannot be fetched, which fails before any transaction opens.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJobRegistry } from "../../src/services/ingest/jobs/registry.js";
import { runIngestJob } from "../../src/services/ingest/jobs/run.js";
import { FAILURE_LOG_FILE, failureRecordOf } from "../../src/services/ingest/jobs/failure-log.js";
import { queuedCompileState, queuedIngestState } from "../../src/services/ingest/jobs/types.js";

/** A scratch project root; the failure log lands under `<root>/.llmwiki/`. */
async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "job-run-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

/**
 * Run one job against a source that cannot be fetched, and return its settled id.
 *
 * The failure is the POINT: it is reached before any transaction opens, so this
 * exercises the settle path without needing a database.
 */
async function runFailingJob(): Promise<{ root: string; registry: ReturnType<typeof createJobRegistry>; jobId: string }> {
  const root = await projectRoot();
  const registry = createJobRegistry();
  const job = registry.create("/nonexistent/source.txt", new Date());
  await runIngestJob({ root, registry, job, compile: false });
  return { root, registry, jobId: job.id };
}

describe("running a job that fails", () => {
  it("settles the ingest dimension as failed with the reason", async () => {
    const { registry, jobId } = await runFailingJob();
    const settled = registry.get(jobId);
    expect(settled?.ingest.status).toBe("failed");
    expect(settled?.ingest.error).toBeDefined();
    // A settle must close the dimension, or a poller cannot know it is over.
    expect(settled?.ingest.endedAt).toBeDefined();
  }, 30_000);

  it("appends one durable failure record", async () => {
    const { root, jobId } = await runFailingJob();
    const log = await readFile(path.join(root, ".llmwiki", FAILURE_LOG_FILE), "utf8");
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.kind).toBe("ingest_job_failed");
    expect(record.jobId).toBe(jobId);
    expect(record.source).toBe("/nonexistent/source.txt");
  }, 30_000);

  it("keeps source text out of the durable record", async () => {
    // The log is meant to be shareable. A record carrying a source body would leak
    // project content into a diagnostic file.
    const job = {
      id: "ing_x",
      source: "https://example.test/a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      ingest: { ...queuedIngestState(), status: "failed" as const, error: "boom" },
      compile: queuedCompileState(),
    };
    const record = failureRecordOf(job);
    expect(Object.keys(record).sort()).toEqual(
      ["at", "error", "jobId", "kind", "source"].sort(),
    );
  });
});
