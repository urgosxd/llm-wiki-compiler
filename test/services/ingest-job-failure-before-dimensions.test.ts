/**
 * @file test/services/ingest-job-failure-before-dimensions.test.ts
 * @description A job that dies BEFORE any dimension is reached must still carry the
 * per-dimension report, naming every known dimension as `not-attempted`.
 *
 * ## The defect this pins
 *
 * Independent verification reproduced it: an async ingest whose source cannot be read
 * settled `failed` with **no `dimensions` key at all**. The job runner built a report only
 * on the `IngestDimensionFailure` path, so every earlier failure — an unreadable source, a
 * `LockBusyError` — left the key off. That is exactly the silence S4 and S9 forbid: a
 * reader could not tell "the graph was not part of the route" from "the run died before the
 * graph was reached", and both rendered as nothing.
 *
 * ## Why the reason is `not-attempted` and not one of the existing three
 *
 * `not-in-route`, `disabled` and `declined` are all claims about a dimension the run
 * RESOLVED. This run resolved none, so each of them would be a false statement about a
 * decision nobody made. The fifth labelled reason says what actually happened: the failure
 * is upstream of the dimension.
 *
 * ## Why no database, no compiler double, no dimension double
 *
 * The failure happens at `fetchContent`, before `writeToDimensions` — and therefore before
 * the dimensions port is resolved at all, which is the whole point of the case. Nothing
 * here needs Postgres or a stand-in: the real service fails in the real way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import { runIngestJob } from "../../packages/wiki/src/services/ingest/jobs/run.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import type { DimensionOutcome } from "../../packages/wiki/src/dimensions/outcome.js";

/** Scratch roots this suite created, removed on teardown. */
const scratchRoots: string[] = [];

/** A project root with NO source in it, so the ingest fails at the first read. */
async function emptyProjectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "job-pre-dimensions-")));
  scratchRoots.push(root);
  return root;
}

/** The report a settled job carries, or a failure that prints the whole record. */
function reportOf(job: IngestJob | undefined): readonly DimensionOutcome[] {
  expect(job?.dimensions, JSON.stringify(job)).toBeDefined();
  return job?.dimensions ?? [];
}

/**
 * Run one job against a source that does not exist, and return the settled record.
 *
 * The failure happens inside the real service, so every case in this file starts the same
 * way; naming it once is what keeps a new case from being a copy of the previous one.
 *
 * @returns The settled record, which every case then reads only assertions out of.
 */
async function runMissingSourceJob(): Promise<IngestJob | undefined> {
  const root = await emptyProjectRoot();
  const registry = createJobRegistry();
  const job = registry.create(path.join(root, "missing-source.txt"), new Date());
  await runIngestJob({ root, registry, job, compile: true });
  return registry.get(job.id);
}

beforeEach(() => {
  // Both dimensions ENABLED is the operator's production configuration, and it is what
  // makes this case sharp: with the switch excluding `kg`, `disabled` would be truthful
  // and the missing label would be untested.
  vi.stubEnv("LLMWIKI_DIMENSIONS", "wiki,kg");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import("node:fs/promises");
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("a job whose source cannot be read", () => {
  it("settles failed AND reports both dimensions as not attempted", async () => {
    const settled = await runMissingSourceJob();
    // The failure is real and upstream: nothing reached the dimensions.
    expect(settled?.ingest.status).toBe("failed");
    expect(settled?.ingest.error).toContain("ENOENT");
    expect(settled?.ingest.error).toContain("missing-source.txt");

    // The regression: one entry per known dimension, in canonical order, both labelled.
    expect(reportOf(settled)).toEqual([
      { name: "wiki", status: "skipped", reason: "not-attempted" },
      { name: "kg", status: "skipped", reason: "not-attempted" },
    ]);
  }, 30_000);

  it("says so in the compile line instead of naming a compile that never started", async () => {
    const settled = await runMissingSourceJob();
    // The compile half never ran, so the line must not claim one dimension compiled while
    // staying silent about the other -- the operator's original complaint, one layer down.
    expect(settled?.compile.status).toBe("skipped");
    expect(settled?.compile.message).toBe(
      "Compile never started: the ingest failed, so there was nothing to compile.",
    );
    expect(reportOf(settled).map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
  }, 30_000);
});

describe("a configuration that cannot be parsed at all", () => {
  it("still settles the job instead of wedging it in running", async () => {
    // The reporting path parses the switch to name the reason behind a skip, and that parse
    // REFUSES an unknown name with `DimensionActivationError`. Letting the refusal escape the
    // settle would leave the job `running` forever: a bug in the code that EXPLAINS a status
    // destroying the status itself. `bogus` is unknown, so this is exactly that refusal.
    vi.stubEnv("LLMWIKI_DIMENSIONS", "wiki,bogus");
    const settled = await runMissingSourceJob();
    expect(settled?.ingest.status).toBe("failed");
    expect(settled?.compile.status).toBe("skipped");
    // Every known dimension is still named, with the one truthful reason: the run died
    // upstream of all of them. An unparseable switch cannot EXCLUDE a dimension from the
    // report either -- the report falls back to naming every known dimension.
    expect(reportOf(settled)).toEqual([
      { name: "wiki", status: "skipped", reason: "not-attempted" },
      { name: "kg", status: "skipped", reason: "not-attempted" },
    ]);
  }, 30_000);
});
