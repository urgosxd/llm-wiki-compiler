/**
 * @file test/services/ingest-job-status-reason.test.ts
 * @description The one place a job's status REASON is derived, and the bound that decides
 * when a row has stopped moving.
 *
 * WHY THESE ASSERTIONS. The reporter's complaint is "la informacion que da es muy pobre":
 * `failed` alone, `busy` alone, or a frozen `running` are states without an explanation,
 * and none of them tells an operator whether to wait, retry, or go look at the process.
 * So the derivation is a pure function with one job per state, and each case here pins
 * one of the three facts a reader must be able to tell apart:
 *
 *  - an OBSERVED failure, quoting the text the pipeline recorded;
 *  - an OBSERVED `busy`, which is settled and carries `retryable: true` because nothing
 *    transitions it onward (L12 of `odd/tasks/ingest-job-hang.md`);
 *  - a DERIVED observation, which is this read's inference from a timestamp and is
 *    marked as such, never presented as something the pipeline reported.
 *
 * Terminality is asked of `isSettled` inside the code under test. Nothing here keeps a
 * second copy of the status lists, and the clock and the bound are both passed in, so no
 * case depends on how fast this machine is.
 */
import { describe, expect, it } from "vitest";
import { abandonedSnapshotOf } from "../../packages/wiki/src/services/ingest/jobs/reaper.js";
import {
  describeJobStatus,
  resolveIngestJobStuckAfterMs,
  withStatusReason,
} from "../../packages/wiki/src/services/ingest/jobs/status.js";
import type {
  CompileDimensionState,
  IngestDimensionState,
  IngestJob,
} from "../../packages/wiki/src/services/ingest/jobs/types.js";
import {
  INGEST_JOB_STUCK_AFTER_ENV_VAR,
  INGEST_JOB_STUCK_AFTER_MS_DEFAULT,
} from "../../packages/wiki/src/utils/constants.js";

/** The reason a `busy` compile reports, verbatim. */
const BUSY_TEXT =
  "The compile did not run: another mutation held the project lock. Retry to compile again.";

/** The bound every case passes in, so none of them reads the environment or a clock. */
const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

/** The instant the last transition happened in the base job below. */
const STAMP = "2026-01-01T00:00:00.000Z";

/** A job that has been created and has done nothing yet. */
const BASE_JOB: IngestJob = {
  id: "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FA",
  source: "note.md",
  createdAt: STAMP,
  updatedAt: STAMP,
  ingest: { status: "running", stage: "fetching", attempts: [] },
  compile: { status: "queued", progress: null },
};

/**
 * A fresh job with one or both dimensions and the stamp replaced.
 *
 * @param patch - What to change on {@link BASE_JOB}.
 * @returns A new snapshot; the base is never mutated.
 */
function jobWith(patch: {
  ingest?: Partial<IngestDimensionState>;
  compile?: Partial<CompileDimensionState>;
  updatedAt?: string;
}): IngestJob {
  return {
    ...BASE_JOB,
    updatedAt: patch.updatedAt ?? BASE_JOB.updatedAt,
    ingest: { ...BASE_JOB.ingest, ...patch.ingest },
    compile: { ...BASE_JOB.compile, ...patch.compile },
  };
}

/** Read the job `offsetMs` after {@link STAMP}. */
function at(offsetMs: number): Date {
  return new Date(Date.parse(STAMP) + offsetMs);
}

/** An environment carrying one value for the stuck bound. */
function envOf(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [INGEST_JOB_STUCK_AFTER_ENV_VAR]: value };
}

describe("the stuck bound", () => {
  it("is a named default of two hours", () => {
    // Pinned so the number cannot drift silently: the bound decides when an operator is
    // told a job is dead, and T6 will settle rows on it.
    expect(INGEST_JOB_STUCK_AFTER_MS_DEFAULT).toBe(2 * 60 * 60 * 1000);
    expect(INGEST_JOB_STUCK_AFTER_ENV_VAR).toBe("LLMWIKI_INGEST_JOB_STUCK_AFTER_MS");
  });

  it("falls back to the named default when the override is absent or unusable", () => {
    // Same rule as the shutdown-flush bound: an unset, empty, non-numeric, zero or
    // negative value is not an instruction to wait forever or to fire immediately.
    for (const value of [undefined, "", "  ", "soon", "0", "-1"]) {
      expect(resolveIngestJobStuckAfterMs(envOf(value))).toBe(INGEST_JOB_STUCK_AFTER_MS_DEFAULT);
    }
  });

  it("reads a positive override from the environment", () => {
    expect(resolveIngestJobStuckAfterMs(envOf("900000"))).toBe(900_000);
    expect(resolveIngestJobStuckAfterMs(envOf(" 60000 "))).toBe(60_000);
  });
});

describe("an observed reason", () => {
  it("quotes an observed ingest failure as the reason", () => {
    const job = jobWith({
      ingest: { status: "failed", endedAt: STAMP, error: "ENOENT: no such file" },
    });
    expect(describeJobStatus(job, { now: at(1_000), stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      reason: "ENOENT: no such file",
      kind: "observed",
    });
  });

  it("quotes an observed compile failure, which the ingest half did not experience", () => {
    const job = jobWith({
      ingest: { status: "succeeded", endedAt: STAMP, message: "Source ingested." },
      compile: { status: "failed", progress: null, error: "provider returned 503" },
    });
    expect(describeJobStatus(job, { now: at(1_000), stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      reason: "provider returned 503",
      kind: "observed",
    });
  });

  it("reports a failure's fallback message rather than an empty reason", () => {
    const job = jobWith({ ingest: { status: "failed", endedAt: STAMP } });
    expect(describeJobStatus(job, { now: at(1_000), stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      reason: "The ingest failed.",
      kind: "observed",
    });
  });

});

describe("a busy compile's reason", () => {
  it("explains a busy compile with the lock it never got", () => {
    const job = jobWith({
      ingest: { status: "succeeded", endedAt: STAMP },
      compile: { status: "busy", progress: null, message: "Another compile holds the lock; retry." },
    });
    // An observed state, not an inference: the compile half reported exactly this.
    expect(describeJobStatus(job, { now: at(1_000), stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      reason: BUSY_TEXT,
      kind: "observed",
    });
    expect(withStatusReason(job, { now: at(1_000), stuckAfterMs: STUCK_AFTER_MS }).compile.retryable)
      .toBe(true);
  });

});

describe("a derived reason", () => {
  it("marks a row that stopped moving before the bound as no reason at all", () => {
    const job = jobWith({});
    expect(describeJobStatus(job, { now: at(STUCK_AFTER_MS), stuckAfterMs: STUCK_AFTER_MS }))
      .toBeUndefined();
    // Inside the bound a silent row is a row that is working; an explanation here would
    // teach an operator to distrust the ones that matter.
    expect(describeJobStatus(job, { now: at(STUCK_AFTER_MS - 1), stuckAfterMs: STUCK_AFTER_MS }))
      .toBeUndefined();
  });

  it("derives a reason for a row that stopped moving past the bound, and says it is derived", () => {
    const job = jobWith({});
    const options = { now: at(STUCK_AFTER_MS + 1), stuckAfterMs: STUCK_AFTER_MS };
    expect(describeJobStatus(job, options)).toEqual({
      reason: `no progress since ${STAMP}; the owning process may have stopped`,
      kind: "derived",
    });
    // The bare fact, separate from the sentence: a reader that wants to render "silent for
    // 3 h" without parsing prose has a field for it.
    expect(withStatusReason(job, options).stalledSince).toBe(STAMP);
  });

  it("never derives a reason from a timestamp it cannot read", () => {
    const job = jobWith({ updatedAt: "not-a-timestamp" });
    const options = { now: at(STUCK_AFTER_MS * 10), stuckAfterMs: STUCK_AFTER_MS };
    expect(describeJobStatus(job, options)).toBeUndefined();
    expect(withStatusReason(job, options)).not.toHaveProperty("stalledSince");
  });

  it("says nothing about a job that settled cleanly", () => {
    const job = jobWith({
      ingest: { status: "unchanged", endedAt: STAMP, message: "Content unchanged; nothing was written." },
      compile: { status: "skipped", progress: null, message: "Compile skipped on request." },
    });
    const options = { now: at(STUCK_AFTER_MS * 2), stuckAfterMs: STUCK_AFTER_MS };
    expect(describeJobStatus(job, options)).toBeUndefined();
    // A settled row is finished, not stalled: the bound describes rows that never moved
    // again, and calling a finished job stalled would be the same lie in the other direction.
    expect(withStatusReason(job, options)).not.toHaveProperty("stalledSince");
  });
});

describe("a failure that also stopped moving", () => {
  it("prefers the recorded failure over the inference, and keeps the inference beside it", () => {
    // Exactly reproduction pair 3: the ingest recorded ENOENT, the compile never started,
    // and the row then sat untouched for three hours.
    const job = jobWith({
      ingest: { status: "failed", endedAt: STAMP, error: "ENOENT: no such file" },
      compile: { status: "queued", progress: null },
    });
    const options = { now: at(STUCK_AFTER_MS + 1), stuckAfterMs: STUCK_AFTER_MS };

    // The operator asked "why is this stuck" and the pipeline HAS an answer.
    expect(describeJobStatus(job, options)).toEqual({
      reason: "ENOENT: no such file",
      kind: "observed",
    });

    // The inference is demoted, never deleted: it rides in its own field, so "it failed"
    // and "nothing has touched this row since" stay two distinguishable facts.
    const view = withStatusReason(job, options);
    expect(view.stalledSince).toBe(STAMP);
    expect(view.statusReason?.kind).toBe("observed");
  });
});

describe("attaching a reason to a job read", () => {
  it("never mutates the snapshot it was given", () => {
    const job = jobWith({
      ingest: { status: "succeeded", endedAt: STAMP },
      compile: { status: "busy", progress: null },
    });
    const before = JSON.stringify(job);
    const view = withStatusReason(job, { now: at(1_000), stuckAfterMs: STUCK_AFTER_MS });
    // The row is the operator's evidence; a read must not edit it, and `busy`'s retry is a
    // property of the view this read returns, never of what is stored.
    expect(JSON.stringify(job)).toBe(before);
    expect(view).not.toBe(job);
    expect(view.compile).not.toBe(job.compile);
    expect(job.compile).not.toHaveProperty("retryable");
  });

  it("returns an untouched value when it is not a job snapshot", () => {
    const notAJob = { hello: "world" };
    expect(withStatusReason(notAJob, { now: at(0), stuckAfterMs: STUCK_AFTER_MS })).toBe(notAJob);
  });

  it("leaves a settled row without a reason or a retry marker", () => {
    const job = jobWith({
      ingest: { status: "unchanged", endedAt: STAMP },
      compile: { status: "skipped", progress: null },
    });
    const view = withStatusReason(job, { now: at(0), stuckAfterMs: STUCK_AFTER_MS });
    expect(view).not.toHaveProperty("statusReason");
    expect(view.compile).not.toHaveProperty("retryable");
  });
});

/**
 * The instant the reap that produced the rows below happened.
 *
 * Later than {@link STAMP}, which is the instant the row last really moved: a reaped row's
 * reason names the second and its `updatedAt` carries the first.
 */
const REAPED_AT = "2026-01-01T02:00:00.000Z";

/** The conclusion a reap records, verbatim, naming the instant the row last moved. */
const ABANDONED_TEXT = `abandoned: no update since ${STAMP}; the process that owned it stopped`;

/**
 * The row a reap writes, built by the WRITER, not by this file.
 *
 * Going through `abandonedSnapshotOf` is what makes these cases about the real payload: a
 * hand-built row could agree with the reader and disagree with the writer.
 *
 * @param withMarker - False to remove the marker, keeping every other byte identical.
 * @returns The stored snapshot.
 */
function reapedJob(withMarker = true): IngestJob {
  const snapshot = abandonedSnapshotOf(BASE_JOB, REAPED_AT);
  if (withMarker) return snapshot;
  const { abandonedAt: _dropped, ...withoutMarker } = snapshot;
  return withoutMarker;
}

/** A read at the reap instant, so a bound is never the explanation for anything below. */
const REAPED_READ = { now: new Date(REAPED_AT), stuckAfterMs: STUCK_AFTER_MS };

describe("a row the reaper concluded was abandoned", () => {
  it("reports its conclusion as DERIVED, because nobody observed this failure", () => {
    // The row now RECORDS the sentence, which is exactly why the marker matters: without it
    // a reader sees a recorded failure and would quote it as something a pipeline saw.
    expect(describeJobStatus(reapedJob(), REAPED_READ)).toEqual({
      reason: ABANDONED_TEXT,
      kind: "derived",
    });
  });

  it("keeps the marker on the view it hands back, and adds no stall to a settled row", () => {
    const view = withStatusReason(reapedJob(), REAPED_READ);

    expect(view.abandonedAt).toBe(REAPED_AT);
    expect(view.statusReason).toEqual({ reason: ABANDONED_TEXT, kind: "derived" });
    // The row is settled, so it is not stalled: `stalledSince` belongs to rows that may move.
    expect(view).not.toHaveProperty("stalledSince");
  });
});

describe("the marker decides the kind, never the wording", () => {
  it("PRESERVE: reports the same failure WITHOUT the marker as an OBSERVED fact", () => {
    // One field apart, and the two rows must not be flattened into one kind: this is the
    // distinction T2's precedence fix exists to protect.
    expect(describeJobStatus(reapedJob(false), REAPED_READ)).toEqual({
      reason: ABANDONED_TEXT,
      kind: "observed",
    });
  });

  it("reports a marker beside unrelated text as derived, so a reword cannot flip it", () => {
    // The other direction of the same rule. A reader that classified by matching the abandoned
    // sentence would call this row observed, and a reaper that changed its wording would
    // silently make every future reap look like a reported failure.
    const reapedWithOtherText: IngestJob = {
      ...reapedJob(),
      ingest: { status: "failed", endedAt: REAPED_AT, attempts: [], error: "ENOENT: no such file" },
    };
    expect(describeJobStatus(reapedWithOtherText, REAPED_READ)).toEqual({
      reason: "ENOENT: no such file",
      kind: "derived",
    });
  });

  it("PRESERVE: still explains a row that finished cleanly with nothing at all", () => {
    const finished: IngestJob = {
      ...BASE_JOB,
      ingest: { status: "succeeded", endedAt: STAMP, attempts: [] },
      compile: { status: "skipped", progress: null },
    };
    expect(describeJobStatus(finished, REAPED_READ)).toBeUndefined();
    expect(withStatusReason(finished, REAPED_READ)).toBe(finished);
  });
});
