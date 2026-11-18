/**
 * @file test/services/ingest-job-dimensions.test.ts
 * @description A settled job must CARRY the per-dimension report, and its compile line
 * must be derived from it instead of being the constant `"Wiki compiled."`.
 *
 * ## What this pins, and why each part is here
 *
 * The reported defect was that a compile said only `Compiled wiki.` while the operator's
 * `.env` enabled both dimensions, so nothing on the record could answer "did `kg` run,
 * was it excluded, or did it fail". Four facts therefore have to be true of a settled job:
 *
 *   1. the record carries ONE entry per known dimension, in canonical order;
 *   2. a dimension the configuration excluded is NAMED as excluded, not omitted;
 *   3. the report survives the view builder both read surfaces share, unchanged;
 *   4. on a failed transaction a dimension that had committed before the rollback is
 *      reported `failed` -- never `declined`, whose message would claim "no changes" for
 *      work that was performed and then discarded.
 *
 * ## Why the database, the compiler and the journal are replaced
 *
 * These cases are about the WIRING between the ingest service, the job record and the
 * compile message, not about Postgres or about a compile. A handle that opens a
 * transaction and touches nothing, a compile that reports success, and a journal that
 * records nothing leave every fact under test observable while keeping the suite in the
 * unit tier -- the same reasoning `test/dimensions/coordinator-report.test.ts` states for
 * its own doubles. The replacements are the narrowest that permit a SUCCESSFUL ingest:
 * everything else is the real service, the real coordinator and the real report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DimensionsPort } from "@repo/foundation";
import { createJobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import { runIngestJob } from "../../packages/wiki/src/services/ingest/jobs/run.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { withStatusReason } from "../../packages/wiki/src/services/ingest/jobs/status.js";
import { describeDimensionMessage } from "../../packages/wiki/src/dimensions/report.js";
import type { DimensionOutcome } from "../../packages/wiki/src/dimensions/outcome.js";
import type { Dimension, DimensionName } from "../../packages/wiki/src/dimensions/types.js";

/** The stand-ins the module mocks read, created before them because `vi.mock` is hoisted. */
const stub = vi.hoisted(() => ({
  db: {
    transaction: async (body: (tx: { execute: () => Promise<unknown[]> }) => Promise<unknown>) =>
      body({ execute: async () => [] }),
  },
}));

vi.mock("../../packages/wiki/src/dimensions/activation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createDimensionsDatabase: () => ({ db: stub.db, close: async () => {} }) };
});

vi.mock("../../packages/wiki/src/compiler/index.js", () => ({
  compileAndReport: async () => ({ busy: false }),
}));

vi.mock("../../packages/wiki/src/utils/activity-log.js", () => ({ appendLog: async () => {} }));

/**
 * The mutation lock, replaced by a passthrough.
 *
 * A CONFIGURED database makes the real lock take an advisory lock over the database it
 * names, which would connect to a host that does not exist. Lock contention has its own
 * suite; these cases are about what the report says once a run holds the project.
 */
vi.mock("../../packages/wiki/src/utils/mutation-lock.js", () => ({
  tryWithOrdinaryMutationLock: async (_root: string, run: () => Promise<unknown>) => ({
    busy: false,
    value: await run(),
  }),
}));

/** A Stack the job names, so the authority settles without asking a database. */
const STACK_ID = "11111111-1111-1111-1111-111111111111";

/** Where the fake wiki dimension says its projection landed. */
const ARTIFACT_PATH = "/tmp/ingest-job-dimensions/note.md";

/**
 * One dimension double that records what it was given and reports a commit.
 *
 * `commitError` is how a case makes this dimension the one that throws: the coordinator
 * rethrows it and wraps the run in `IngestDimensionFailure`, which is the path case 4 is
 * about.
 */
function dimensionNamed(name: DimensionName, commitError?: Error): Dimension {
  return {
    name,
    prepare: async () => ({ unchanged: false, handle: {} }),
    commit: async () => {
      if (commitError !== undefined) throw commitError;
      return {
        idempotencyKey: `${name}:key`,
        summary: `${name} committed`,
        ...(name === "wiki"
          ? { afterCommit: async () => ({ artifactPath: ARTIFACT_PATH, writeStatus: "created" as const }) }
          : {}),
      };
    },
    discard: async () => {},
    forget: async () => {},
  };
}

/** A port answering with exactly the dimensions a case composed. */
function portOf(dimensions: readonly Dimension[]): DimensionsPort<Dimension> {
  return { resolve: () => dimensions };
}

/** A scratch project root holding one readable source, so a real ingest can succeed. */
async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "job-dimensions-")));
  await writeFile(
    path.join(root, "note.md"),
    "# Note\n\nA sentence long enough that the ingest does not report short content.\n",
    "utf8",
  );
  return root;
}

/**
 * Run one job to settlement against the dimensions a case composed.
 *
 * `compile: true` is deliberate: the derived compile message is only recorded on the
 * success settle, which is the branch the reported defect was about.
 */
async function runJob(dimensions: readonly Dimension[]): Promise<{
  registry: ReturnType<typeof createJobRegistry>;
  jobId: string;
}> {
  const root = await projectRoot();
  const registry = createJobRegistry();
  const job = registry.create(path.join(root, "note.md"), new Date());
  await runIngestJob({
    root,
    registry,
    job,
    compile: true,
    stackId: STACK_ID,
    dimensionsPort: portOf(dimensions),
  });
  return { registry, jobId: job.id };
}

/** The report a settled job carries, or a named failure instead of a vague one. */
function reportOf(job: IngestJob | undefined): readonly DimensionOutcome[] {
  expect(job?.dimensions, JSON.stringify(job)).toBeDefined();
  return job?.dimensions ?? [];
}

beforeEach(() => {
  // A CONFIGURED database is what makes the Stack authority answer `stack` rather than the
  // named file mode; the handle itself is the double mocked above, so nothing connects.
  vi.stubEnv("AKS_DATABASE_URL", "postgres://fake.invalid:5432/fake");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the report a settled job carries", () => {
  it("has one entry per known dimension when both ran, and derives the compile line", async () => {
    const { registry, jobId } = await runJob([dimensionNamed("wiki"), dimensionNamed("kg")]);
    const settled = registry.get(jobId);

    // Canonical order, one entry each: a MISSING entry is the silence this feature removes.
    expect(reportOf(settled).map((outcome) => outcome.name)).toEqual(["wiki", "kg"]);
    expect(reportOf(settled)).toEqual([
      { name: "wiki", status: "succeeded", summary: "wiki committed" },
      { name: "kg", status: "succeeded", summary: "kg committed" },
    ]);
    // The exact derived string, which also proves the constant is gone: it cannot read
    // "Wiki compiled." here, and that constant is what the operator reported.
    expect(settled?.compile.status).toBe("succeeded");
    expect(settled?.compile.message).toBe("Compiled wiki and kg.");
  }, 30_000);

  it("names a dimension the configuration excluded instead of omitting it", async () => {
    const { registry, jobId } = await runJob([dimensionNamed("wiki")]);
    const settled = registry.get(jobId);

    expect(reportOf(settled)).toEqual([
      { name: "wiki", status: "succeeded", summary: "wiki committed" },
      { name: "kg", status: "skipped", reason: "disabled" },
    ]);
    // The acceptance wording, character for character: the operator is told WHY the graph
    // is absent, so nobody hunts a configuration that was already correct.
    expect(settled?.compile.message).toBe(
      "Compiled wiki. kg: disabled by LLMWIKI_DIMENSIONS.",
    );
  }, 30_000);
});

describe("the report as the read surfaces serve it", () => {
  it("survives the one view builder both surfaces call, unchanged", async () => {
    const dimensions: readonly DimensionOutcome[] = [
      { name: "wiki", status: "succeeded", summary: "wiki committed" },
      { name: "kg", status: "skipped", reason: "not-in-route" },
    ];
    // A live, silent row: the builder must REBUILD this view to add `stalledSince`, which
    // is the only way to prove the report survives a rebuild rather than being handed back
    // by identity on a row that needed no explanation.
    const job: IngestJob = {
      id: "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FA",
      source: "note.md",
      createdAt: "2024-05-01T10:00:00.000Z",
      updatedAt: "2024-05-01T10:00:00.000Z",
      ingest: { status: "running", stage: "fetching", attempts: [] },
      compile: { status: "queued", progress: null },
      dimensions,
    };

    const view = withStatusReason<IngestJob>(job, {
      now: new Date("2025-05-01T10:00:00.000Z"),
      stuckAfterMs: 60_000,
    });

    expect(view).not.toBe(job);
    expect(view.stalledSince).toBeDefined();
    expect(view.dimensions).toBe(dimensions);
    expect(view.dimensions).toEqual(dimensions);
  });
});

describe("the report of a failed transaction", () => {
  it("reports a rolled-back dimension as failed, never as having no changes", async () => {
    const failure = new Error("kg commit refused by the graph store");
    const { registry, jobId } = await runJob([dimensionNamed("wiki"), dimensionNamed("kg", failure)]);
    const settled = registry.get(jobId);
    const report = reportOf(settled);

    expect(settled?.ingest.status).toBe("failed");
    // Both dimensions failed the RUN: the wiki committed inside the transaction that then
    // rolled back, so its work does not exist. `declined` would read "no changes" about work
    // that was performed and discarded, which is the lie this assertion exists to prevent.
    expect(report.map((outcome) => outcome.status)).toEqual(["failed", "failed"]);
    const rolledBack = report.find((outcome) => outcome.name === "wiki");
    expect(rolledBack?.status === "failed" ? rolledBack.error : "").toContain(
      "kg commit refused by the graph store",
    );
    const message = describeDimensionMessage(report);
    expect(message).toBe("Nothing compiled. wiki: failed. kg: failed.");
    expect(message).not.toMatch(/no changes/);
    expect(message).not.toMatch(/not part of this route/);
  }, 30_000);
});

