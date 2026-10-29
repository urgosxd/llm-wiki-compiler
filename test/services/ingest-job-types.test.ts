/**
 * @file test/services/ingest-job-types.test.ts
 * @description The job contract must make an INVENTED percentage impossible.
 *
 * WHY THESE ASSERTIONS. The requirement is explicit: if the pipeline does not know
 * how much work is done, it must report the stage and an indeterminate indicator
 * rather than a made-up number. A convention ("remember not to divide") would
 * erode; the type does not, because there is no field to put a percentage in.
 *
 * So this file pins the property that matters: `progress` is either `null` or an
 * exact completed/total pair, and a stage with no denominator reports `null`.
 * `compile-observer` is where that decision is made, so it is measured directly.
 */
import { describe, expect, it } from "vitest";
import {
  jobStageFor,
  reportCompileProgress,
  reportCompileStage,
} from "../../src/services/ingest/jobs/compile-observer.js";
import type { CompileDetail, CompileStage, JobProgress } from "../../src/services/ingest/jobs/types.js";

/** A reporter that records what it was told, instead of writing a job. */
function recordingReporter() {
  const stages: CompileStage[] = [];
  const progress: (JobProgress | null)[] = [];
  const details: (CompileDetail | null)[] = [];
  return {
    stages,
    progress,
    details,
    reporter: {
      stage: (stage: CompileStage) => stages.push(stage),
      progress: (next: JobProgress | null) => progress.push(next),
      detail: (next: CompileDetail | null) => details.push(next),
    },
  };
}

describe("the compile observer", () => {
  it("maps every measured compile stage onto a job stage", () => {
    expect(jobStageFor("compile.detect-changes")).toBe("detect_changes");
    expect(jobStageFor("compile.extraction")).toBe("extraction");
    expect(jobStageFor("compile.page-generation")).toBe("page_generation");
    expect(jobStageFor("compile.finalize")).toBe("finalize");
    expect(jobStageFor("compile.embeddings")).toBe("embeddings");
  });

  it("reports a query stage as no job stage rather than inventing one", () => {
    // A query is not a compile. Mapping it would make the job claim a stage the
    // pipeline never performed.
    expect(jobStageFor("query.retrieval")).toBeUndefined();
    expect(jobStageFor("query.answer")).toBeUndefined();
  });

  it("clears progress when the stage advances", () => {
    // Carrying page-generation's counts into finalize would show a finished bar
    // while finalize had just begun: fabricated progress, exactly what is banned.
    const recorder = recordingReporter();
    reportCompileStage(recorder.reporter, "compile.finalize");
    expect(recorder.stages).toEqual(["finalize"]);
    expect(recorder.progress).toEqual([null]);
  });

  it("reports null for a stage with nothing to do instead of 0 of 0", () => {
    // A client that divides by `total` would get NaN from 0/0. Nothing-to-do is
    // unknown progress, not zero progress.
    const recorder = recordingReporter();
    reportCompileProgress(recorder.reporter, 0, 0);
    expect(recorder.progress).toEqual([null]);
  });

  it("reports an exact pair when the denominator is real", () => {
    const recorder = recordingReporter();
    reportCompileProgress(recorder.reporter, 3, 8);
    expect(recorder.progress).toEqual([{ completed: 3, total: 8 }]);
  });

  it("never reports more completed than total", () => {
    // Generation can write more pages than concepts were merged, so the completed
    // count is clamped rather than trusted: a bar past 100% reads as a bug.
    const recorder = recordingReporter();
    reportCompileProgress(recorder.reporter, 9, 4);
    expect(recorder.progress).toEqual([{ completed: 4, total: 4 }]);
  });

  it("is a no-op when no job is being tracked", () => {
    // The CLI and the MCP server pass no observer. This must not throw, because
    // every ingest they run goes through the same pipeline.
    expect(() => reportCompileStage(undefined, "compile.extraction")).not.toThrow();
    expect(() => reportCompileProgress(undefined, 1, 2)).not.toThrow();
  });
});
