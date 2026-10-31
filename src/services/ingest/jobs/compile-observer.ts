/**
 * @file src/services/ingest/jobs/compile-observer.ts
 * @description Turns the compile pipeline's existing `timeStage` boundaries into
 * job-visible stages, without adding a stage the pipeline does not already measure.
 *
 * ## Why the compile observer is derived, not hand-placed
 *
 * The compile pipeline already names its stages: `timeStage("compile.extraction",
 * …)` is a real boundary with a real duration. If this module invented its OWN
 * stage vocabulary and hand-placed calls, the job would slowly drift from the
 * pipeline -- a renamed stage would keep the job reporting, and reporting
 * something that no longer exists.
 *
 * So the compile stages are DERIVED from the timing stage names by an exhaustive
 * mapping. Adding a `TimedStage` without deciding what the job should show is a
 * type error, not a silently missing stage.
 *
 * ## Two stages carry a real denominator; the rest are honestly unknown
 *
 * `page_generation` and `finalize` count pages, and the counts come from the
 * pipeline's own results. Every other stage reports `null` rather than a made-up
 * ratio, which is the whole reason {@link JobProgress} cannot express a
 * percentage.
 */

import type { TimedStage } from "../../../utils/stage-timing.js";
import type { CompileProgressReporter, CompileStage, JobProgress } from "./types.js";

/**
 * Every compile stage a job can report, keyed by the timing stage it comes from.
 *
 * Exhaustive over the compile half of {@link TimedStage}: the `query.*` entries are
 * absent because they are not compiles, and TypeScript rejects a missing
 * `compile.*` key.
 */
const TIMED_STAGE_TO_JOB_STAGE: Record<
  Exclude<TimedStage, `query.${string}`>,
  CompileStage
> = {
  "compile.detect-changes": "detect_changes",
  "compile.extraction": "extraction",
  "compile.page-generation": "page_generation",
  "compile.finalize": "finalize",
  "compile.embeddings": "embeddings",
};

/**
 * Translate a timing stage name into the job's compile stage, or `undefined`.
 *
 * Total by construction for compile stages; `undefined` only for a query stage,
 * which no compile run produces. Returning `undefined` instead of throwing keeps
 * this usable from a path that must never fail a compile.
 *
 * @param stage - The `timeStage` name the pipeline is about to run.
 * @returns The matching job stage, or `undefined` when this is not a compile stage.
 */
export function jobStageFor(
  stage: TimedStage,
): CompileStage | undefined {
  return stage in TIMED_STAGE_TO_JOB_STAGE
    ? TIMED_STAGE_TO_JOB_STAGE[stage as keyof typeof TIMED_STAGE_TO_JOB_STAGE]
    : undefined;
}

/**
 * Report a stage transition, then clear progress back to "unknown".
 *
 * Clearing matters: carrying the previous stage's counts into the next one would
 * show a finished `page_generation` bar while `finalize` was still starting, which
 * is exactly the fabricated progress the feature forbids.
 *
 * @param reporter - Sink for the transition, when a job is being tracked.
 * @param stage - The `timeStage` name the pipeline is about to run.
 */
export function reportCompileStage(
  reporter: CompileProgressReporter | undefined,
  stage: TimedStage,
): void {
  const jobStage = jobStageFor(stage);
  if (reporter === undefined || jobStage === undefined) return;
  reporter.stage(jobStage);
  reporter.progress(null);
  // Clearing detail is the same rule as clearing progress: a previous stage's
  // cardinalities describe work that is already finished, and leaving them up
  // would attribute the last stage's chunk count to the one now starting.
  // `null`, not `{}`: an empty object stays PRESENT, so a consumer checking
  // `detail !== undefined` would render an empty cardinality line instead of none.
  reporter.detail(null);
}

/**
 * Publish an exact completed/total pair for the current stage.
 *
 * A `total` of zero means the stage had nothing to do, and reports `null`: "0 of 0"
 * is not progress, and a client that divides would get `NaN`.
 *
 * @param reporter - Sink for the counts, when a job is being tracked.
 * @param completed - Units finished.
 * @param total - Units the stage will process.
 */
export function reportCompileProgress(
  reporter: CompileProgressReporter | undefined,
  completed: number,
  total: number,
): void {
  if (reporter === undefined) return;
  if (total <= 0) {
    reporter.progress(null);
    return;
  }
  const progress: JobProgress = { completed: Math.min(completed, total), total };
  reporter.progress(progress);
}
