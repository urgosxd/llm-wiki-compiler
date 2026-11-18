/**
 * @file test/viewer/api-ingest-jobs-status.test.ts
 * @description A job the operator cannot act on must SAY why, through the public status route.
 *
 * WHY THESE ASSERTIONS. The reporter's third complaint is "la informacion que da es muy
 * pobre": the status route answered a job with `failed` or `busy` or a frozen `running`
 * and no explanation a person could act on. Three separate facts had to become legible,
 * and each group below is aimed at one:
 *
 *  1. A terminal failure must carry its own error text into the STORED row and out
 *     through this route — not only into `.llmwiki/ingest-failures.jsonl`, which is what
 *     the measured hang did.
 *  2. A `busy` compile must say the project lock is why the compile did not run, and
 *     must be marked retryable, because `busy` is settled and nothing transitions it
 *     onward. Silence there is what made the operator's only remedy invisible.
 *  3. A row that is STILL non-terminal long past a named bound must be reported as a
 *     derived observation — "no progress since …; the owning process may have stopped" —
 *     which is a different claim from an observed failure and must be marked as one.
 *
 * Terminality is asked of the registry's `isSettled` predicate through the code under
 * test; nothing here keeps a second copy of the status lists.
 *
 * The database is replaced by a handle that CAPTURES the payloads `saveIngestJob` hands
 * the driver (see `test/fixtures/ingest-job-status-surface.ts`), so these cases run
 * without Postgres. What is asserted is the bytes that would be committed, which is
 * exactly what a durable reader would read back.
 */
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import { FAILURE_LOG_FILE } from "../../packages/wiki/src/services/ingest/jobs/failure-log.js";
import { createJobRegistry, type JobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import { runIngestJob } from "../../packages/wiki/src/services/ingest/jobs/run.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { INGEST_JOB_STUCK_AFTER_ENV_VAR } from "../../packages/wiki/src/utils/constants.js";
import { handleApiIngestJobs, INGEST_JOBS_PATH } from "../../packages/wiki/src/viewer/api-ingest-jobs.js";
import {
  capturingHandle,
  readLiveJob,
  readStoredJob,
  recordingResponse,
  type CapturingHandle,
} from "../fixtures/ingest-job-status-surface.js";

/**
 * Base instant every stamp in this file is relative to, taken ONCE at load.
 *
 * Relative rather than absolute because `registry.ts` evicts a SETTLED job whose last
 * transition is more than an hour old: a fixed 2026 stamp would make the settled cases
 * vanish before they were read.
 */
const BASE_MS = Date.now();

/** The tenant the captured rows belong to. Nothing here reads it back. */
const STACK_ID = "stk_01J8ZQK4N7Q9V0R2T4X6B8D0FA";

/** A source that cannot be read, so the ingest fails before any transaction opens. */
const MISSING_SOURCE = "/nonexistent/source.txt";

/** The default stuck bound, spelled out so a change to it has to come here too. */
const STUCK_AFTER_DEFAULT_MS = 2 * 60 * 60 * 1000;

/** Long enough for the mirror chain to hand every captured write to the handle. */
const FLUSH_BOUND_MS = 10_000;

/** What the reporter is told when the compile could not start, verbatim. */
const BUSY_COMPILE_TEXT =
  "The compile did not run: another mutation held the project lock. Retry to compile again.";

/** What the ingest reports for a source it cannot read, verbatim, as the row stores it. */
const UNREADABLE_SOURCE_TEXT =
  "ENOENT: no such file or directory, open '/nonexistent/source.txt'";

/** ISO instant `offsetMs` from {@link BASE_MS}. */
function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** The instant a route read should pretend it is, `offsetMs` from {@link BASE_MS}. */
function nowAt(offsetMs: number): Date {
  return new Date(BASE_MS + offsetMs);
}

/** Scratch project roots this file created, removed when the file finishes. */
const scratchRoots: string[] = [];

/** The stuck bound the process started with, restored after every case. */
const INITIAL_STUCK_BOUND = process.env[INGEST_JOB_STUCK_AFTER_ENV_VAR];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
  if (INITIAL_STUCK_BOUND === undefined) delete process.env[INGEST_JOB_STUCK_AFTER_ENV_VAR];
  else process.env[INGEST_JOB_STUCK_AFTER_ENV_VAR] = INITIAL_STUCK_BOUND;
});

/** A scratch project root; the failure log lands under `<root>/.llmwiki/`. */
async function scratchRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "job-status-")));
  scratchRoots.push(root);
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

/** A stored row that is still non-terminal by `isSettled`, last moved at {@link BASE_MS}. */
function staleRunningRow(): { id: string } & Record<string, unknown> {
  return {
    id: "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FD",
    source: "note.md",
    createdAt: at(0),
    updatedAt: at(0),
    ingest: { status: "running", stage: "fetching", attempts: [] },
    compile: { status: "queued", progress: null },
  };
}

/** Create a job in `registry` and park it mid-ingest at {@link BASE_MS}. */
function unfinishedJob(registry: JobRegistry): IngestJob {
  const job = registry.create("note.md", nowAt(0));
  registry.patchIngest(job.id, { status: "running", stage: "fetching" }, nowAt(0));
  return job;
}

/** Run one job against an unreadable source through the durable mirror, and settle it. */
async function runFailingJob(): Promise<{
  root: string;
  registry: ReturnType<typeof createDurableJobRegistry>;
  jobId: string;
  capture: CapturingHandle;
}> {
  const root = await scratchRoot();
  const capture = capturingHandle();
  const registry = createDurableJobRegistry(createJobRegistry(), { db: capture.db, stackId: STACK_ID });
  const job = registry.create(MISSING_SOURCE, nowAt(0));
  await runIngestJob({ root, registry, job, compile: false });
  await registry.flushMirror(FLUSH_BOUND_MS);
  return { root, registry, jobId: job.id, capture };
}

describe("a stored failure's reason", () => {
  it("carries a failed job's own error text into the stored row and reports it as observed", async () => {
    const { root, jobId, capture } = await runFailingJob();
    const stored = capture.last();
    expect(stored?.ingest.status).toBe("failed");
    // The exact text, not merely "some error": the durable failure log records the same
    // string, so a row that carried only `failed` would be the defect this case pins.
    expect(stored?.ingest.error).toBe(UNREADABLE_SOURCE_TEXT);
    const logged = JSON.parse(
      (await readFile(path.join(root, ".llmwiki", FAILURE_LOG_FILE), "utf8")).trim(),
    ) as { error?: string };
    expect(logged.error).toBe(UNREADABLE_SOURCE_TEXT);

    const { status, json } = await readStoredJob(stored, jobId, nowAt(0));
    expect(status).toBe(200);
    expect(json.ingest).toMatchObject({ status: "failed", error: UNREADABLE_SOURCE_TEXT });
    // An observed failure, marked as observed: this is what the pipeline itself recorded,
    // not something this read inferred from a timestamp.
    expect(json.statusReason).toEqual({ reason: UNREADABLE_SOURCE_TEXT, kind: "observed" });
  }, 30_000);
});

describe("a busy compile's reason", () => {
  it("marks a busy compile retryable and names the project lock as its reason", async () => {
    const registry = createJobRegistry();
    const job = registry.create("note.md", nowAt(0));
    registry.patchIngest(
      job.id,
      { status: "succeeded", endedAt: at(1_000), message: "Source ingested." },
      nowAt(1_000),
    );
    registry.patchCompile(
      job.id,
      { status: "busy", progress: null, endedAt: at(2_000), message: "Another compile holds the lock; retry." },
      nowAt(2_000),
    );

    const { status, json } = await readLiveJob(registry, job.id, nowAt(2_000));
    expect(status).toBe(200);
    // `busy` is settled (isSettled counts it) and nothing moves it onward, so the retry it
    // offers has to be explicit or the operator's only remedy stays invisible.
    expect(json.compile).toMatchObject({ status: "busy", retryable: true });
    expect(json.statusReason).toEqual({ reason: BUSY_COMPILE_TEXT, kind: "observed" });
  });
});

describe("a row that stopped moving", () => {
  it("reports a derived reason once it is past the named bound", async () => {
    const registry = createJobRegistry();
    const job = unfinishedJob(registry);
    const { json } = await readLiveJob(registry, job.id, nowAt(STUCK_AFTER_DEFAULT_MS + 1));

    expect(json.ingest).toMatchObject({ status: "running", stage: "fetching" });
    expect(json.updatedAt).toBe(at(0));
    expect(json.statusReason).toEqual({
      reason: `no progress since ${at(0)}; the owning process may have stopped`,
      kind: "derived",
    });
    expect(json.stalledSince).toBe(at(0));
    // No retry is offered for a derived observation: the row still claims to be running,
    // and offering one here would invite a second write against work that may be live.
    expect(json.compile).not.toHaveProperty("retryable");
  });

  it("is not called stuck while it is still inside the bound", async () => {
    const registry = createJobRegistry();
    const job = unfinishedJob(registry);
    // Exactly at the bound, not one millisecond past it: a row that has not spoken
    // recently is not a row that stopped, and this read must invent no reason for it.
    const { json } = await readLiveJob(registry, job.id, nowAt(STUCK_AFTER_DEFAULT_MS));

    expect(json.ingest).toMatchObject({ status: "running" });
    expect(json).not.toHaveProperty("statusReason");
    expect(json).not.toHaveProperty("stalledSince");
    expect(JSON.stringify(json)).not.toContain("may have stopped");
  });

});

describe("a stalled row in the collection listing", () => {
  it("is explained there too", async () => {
    const registry = createJobRegistry();
    const job = unfinishedJob(registry);
    const recorded = recordingResponse();
    await handleApiIngestJobs(recorded.res, new URL(`http://viewer.test${INGEST_JOBS_PATH}`), {
      ingestJobs: registry,
      now: () => nowAt(STUCK_AFTER_DEFAULT_MS + 1),
    });
    expect(recorded.statusCode()).toBe(200);
    const body = JSON.parse(recorded.body()) as { jobs: { id: string; statusReason?: unknown }[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe(job.id);
    // One rule, both routes: an operator who lists jobs must not have to open each one to
    // learn that it died.
    expect(body.jobs[0].statusReason).toEqual({
      reason: `no progress since ${at(0)}; the owning process may have stopped`,
      kind: "derived",
    });
  });
});

describe("a failure that also stopped moving", () => {
  it("reports the observed error, and the derived stall in its own field", async () => {
    // Reproduction pair 3, as the row was left: `failed` / `queued`, three hours silent.
    const row = {
      id: "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FA",
      source: MISSING_SOURCE,
      createdAt: at(0),
      updatedAt: at(0),
      ingest: { status: "failed", endedAt: at(0), attempts: [], error: UNREADABLE_SOURCE_TEXT },
      compile: { status: "queued", progress: null },
    };
    const { status, json } = await readStoredJob(row, row.id, nowAt(3 * 60 * 60 * 1000));

    expect(status).toBe(200);
    // What the pipeline recorded outranks what this read inferred.
    expect(json.statusReason).toEqual({ reason: UNREADABLE_SOURCE_TEXT, kind: "observed" });
    // And the inference is still there, as a fact of its own rather than folded into prose.
    expect(json.stalledSince).toBe(at(0));
  });
});

describe("the bound the route reads", () => {
  it("reads it from the environment on every request", async () => {
    const row = staleRunningRow();
    process.env[INGEST_JOB_STUCK_AFTER_ENV_VAR] = "60000";

    // Exactly at the configured minute: inside the bound, so this row is still working.
    const atBound = await readStoredJob(row, row.id, nowAt(60_000));
    expect(atBound.json).not.toHaveProperty("statusReason");
    expect(atBound.json).not.toHaveProperty("stalledSince");

    const pastBound = await readStoredJob(row, row.id, nowAt(60_001));
    expect(pastBound.json.statusReason).toEqual({
      reason: `no progress since ${at(0)}; the owning process may have stopped`,
      kind: "derived",
    });
    expect(pastBound.json.stalledSince).toBe(at(0));
  });

  it("falls back to the named default when the override is unusable", async () => {
    const row = staleRunningRow();
    process.env[INGEST_JOB_STUCK_AFTER_ENV_VAR] = "not-a-number";

    // A minute of silence is inside the two-hour default, so a typo cannot make every live
    // job look stuck the moment it is written.
    const silentForAMinute = await readStoredJob(row, row.id, nowAt(60_000));
    expect(silentForAMinute.json).not.toHaveProperty("statusReason");

    const silentForThreeHours = await readStoredJob(row, row.id, nowAt(3 * 60 * 60 * 1000));
    expect(silentForThreeHours.json.statusReason).toMatchObject({ kind: "derived" });
  });
});

describe("a read that explains nothing into the row", () => {
  it("leaves the stored row, and its live snapshot, byte-identical across a read", async () => {
    const { jobId, capture, registry } = await runFailingJob();
    const stored = capture.last();
    const rowBefore = JSON.stringify(stored);
    const capturedBefore = JSON.stringify(capture.all());
    const liveBefore = JSON.stringify(registry.get(jobId));

    await readStoredJob(stored, jobId, nowAt(0));
    await readStoredJob(stored, jobId, nowAt(0));

    // A status read REPORTS a reason; it must never write one into the row, and it must
    // never issue a statement at all.
    expect(JSON.stringify(stored)).toBe(rowBefore);
    expect(JSON.stringify(capture.all())).toBe(capturedBefore);
    expect(JSON.stringify(registry.get(jobId))).toBe(liveBefore);
  }, 30_000);
});

describe("what the route already answered", () => {
  it("still answers 404 with the same envelope for a job this host never had", async () => {
    const recorded = recordingResponse();
    await handleApiIngestJobs(
      recorded.res,
      new URL(`http://viewer.test${INGEST_JOBS_PATH}/ing_missing`),
      { ingestJobs: createJobRegistry(), now: () => nowAt(0) },
    );
    expect(recorded.statusCode()).toBe(404);
    expect(JSON.parse(recorded.body())).toEqual({
      error: { code: "job_not_found", message: "no ingest job 'ing_missing'" },
    });
  });

  it("still serves a settled job's own fields, adding no reason where there is none", async () => {
    const registry = createJobRegistry();
    const job = registry.create("note.md", nowAt(0));
    registry.patchIngest(
      job.id,
      { status: "unchanged", endedAt: at(1_000), message: "Content unchanged; nothing was written." },
      nowAt(1_000),
    );
    registry.patchCompile(
      job.id,
      { status: "skipped", progress: null, message: "Compile skipped on request." },
      nowAt(2_000),
    );

    const { json } = await readLiveJob(registry, job.id, nowAt(2_000));
    expect(json).toMatchObject({
      id: job.id,
      source: "note.md",
      createdAt: at(0),
      updatedAt: at(2_000),
      ingest: { status: "unchanged", message: "Content unchanged; nothing was written." },
      compile: { status: "skipped", progress: null, message: "Compile skipped on request." },
    });
    // A job that finished cleanly needs no explanation, and inventing one would be the
    // same defect as omitting one where it was needed.
    expect(json).not.toHaveProperty("statusReason");
    expect(json.compile).not.toHaveProperty("retryable");
  });
});

/** The instant the reap below happened: later than the row's last real movement. */
const REAPED_AT = at(60_000);

/** The conclusion a reap records, verbatim: derived, and naming the instant it last moved. */
const ABANDONED_TEXT = `abandoned: no update since ${at(0)}; the process that owned it stopped`;

/**
 * A row a reap settled, as the reaper stores it: terminal on both halves, the derived sentence
 * in each `error`, and the machine-readable marker `abandonedAt` beside them.
 *
 * @param withMarker - False to remove the marker and keep every other byte.
 * @returns The stored snapshot.
 */
function reapedRow(withMarker = true): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FE",
    source: "note.md",
    createdAt: at(0),
    updatedAt: REAPED_AT,
    abandonedAt: REAPED_AT,
    ingest: { status: "failed", stage: "fetching", endedAt: REAPED_AT, attempts: [], error: ABANDONED_TEXT },
    compile: { status: "failed", progress: null, endedAt: REAPED_AT, error: ABANDONED_TEXT },
  };
  if (!withMarker) delete row.abandonedAt;
  return row;
}

describe("a row the reaper settled", () => {
  it("answers its conclusion as DERIVED, because nobody observed this failure", async () => {
    const row = reapedRow();
    const { status, json } = await readStoredJob(row, row.id as string, nowAt(3 * 60 * 60 * 1000));

    expect(status).toBe(200);
    // The marker is what says so. Reading the sentence back as `observed` would tell a client
    // that a pipeline reported a failure it never reported.
    expect(json.statusReason).toEqual({ reason: ABANDONED_TEXT, kind: "derived" });
    // The marker itself rides on the answer, so a client can tell without parsing prose.
    expect(json.abandonedAt).toBe(REAPED_AT);
    // Settled, so not stalled: that field belongs to rows that may still be working.
    expect(json).not.toHaveProperty("stalledSince");
  });

  it("PRESERVE: answers the identical row WITHOUT the marker as OBSERVED", async () => {
    const row = reapedRow(false);
    const { json } = await readStoredJob(row, row.id as string, nowAt(3 * 60 * 60 * 1000));

    // Same text, one field apart: a row that really failed keeps its observed kind.
    expect(json.statusReason).toEqual({ reason: ABANDONED_TEXT, kind: "observed" });
    expect(json).not.toHaveProperty("abandonedAt");
  });
});
