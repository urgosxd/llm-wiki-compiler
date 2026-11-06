/**
 * @file packages/llmwiki-kg/ts/src/core/eval/report.ts
 * @description Rendering one report twice: readable text for a human, JSON for a tool.
 *
 * ## Every metric carries its axis in its own name
 *
 * A line reads `classifier.confusion.wrongCanonicalType`, not `wrong` under a heading
 * a reader has to remember. The same rule holds in the JSON, where the numbers are
 * nested under their axis and nothing appears at the top level except the set and
 * catalog versions and the run description. A consumer that takes one number out of
 * the document can always say which stage that number measures.
 *
 * ## There is no total, and the text says so
 *
 * {@link NO_AGGREGATE_NOTE} is printed with every report. It is not decoration: the
 * one mistake this format is built to prevent is reading extractor coverage and
 * classifier accuracy as parts of a single grade, when a candidate the extractor
 * never produced was never seen by the classifier at all.
 *
 * ## The endpoint is redacted here as well
 *
 * The run description carries the configured base URL, which an operator can paste a
 * credential into. Both renderers pass it through the redaction helper instead of
 * trusting whoever built the report, so a text report, a JSON report and a caller
 * that assembled its own {@link RunInfo} all publish the same safe form.
 */

import { redactSecrets } from "../jev/redact.js";
import type { EvalReport, RunInfo } from "./types.js";

/** The note printed with every report, stating why no total exists. */
export const NO_AGGREGATE_NOTE =
  "note: no aggregate score is reported. Extractor coverage and classifier quality measure different stages: JEV cannot recover a candidate the extractor omitted, so the two numbers must never be summed into one score.";

/** How wide the metric-name column is, so values line up. */
const NAME_WIDTH = 49;

/**
 * Formats one metric line.
 *
 * @param name - The axis-qualified metric name.
 * @param value - The number or string to print.
 * @returns One padded line.
 */
function metric(name: string, value: number | string): string {
  return `  ${name.padEnd(NAME_WIDTH)}${String(value)}`;
}

/**
 * Formats a ratio as a fixed-precision number, so two runs compare by eye.
 *
 * @param value - The ratio.
 * @returns The ratio with three decimals.
 */
function decimal(value: number): string {
  return value.toFixed(3);
}

/**
 * The run description as it may be published, with the endpoint credential redacted.
 *
 * @param run - The run description the caller supplied.
 * @returns The same description with a safe base URL.
 */
function reportedRun(run: RunInfo): RunInfo {
  return run.baseUrl === null ? run : { ...run, baseUrl: redactSecrets(run.baseUrl, []) };
}

/**
 * Renders the classifier axis.
 *
 * @param report - The report.
 * @returns Its lines.
 */
function classifierLines(report: EvalReport): string[] {
  const { classification } = report;
  return [
    "[classifier] canonical-type quality, over the candidates a classifier judged",
    metric("classifier.evaluated", classification.evaluated),
    metric("classifier.correct", classification.correct),
    metric("classifier.accuracy", decimal(classification.accuracy)),
    metric("classifier.abstentions", classification.abstentions),
    metric("classifier.abstentionRate", decimal(classification.abstentionRate)),
    metric("classifier.confusion.correctCanonicalType", classification.confusion.correctCanonicalType),
    metric("classifier.confusion.correctAbstention", classification.confusion.correctAbstention),
    metric("classifier.confusion.wrongCanonicalType", classification.confusion.wrongCanonicalType),
    metric("classifier.confusion.abstainedWhenTypeExisted", classification.confusion.abstainedWhenTypeExisted),
    metric("classifier.confusion.classifiedWhenNotDecidable", classification.confusion.classifiedWhenNotDecidable),
    metric("classifier.confusion.abstentionReasonMismatch", classification.confusion.abstentionReasonMismatch),
  ];
}

/**
 * Renders the support axis.
 *
 * @param report - The report.
 * @returns Its lines.
 */
function supportLines(report: EvalReport): string[] {
  const { support } = report;
  return [
    "[support] semantic support of the cited quote, over the claims a classifier judged",
    metric("support.judged", support.judged),
    metric("support.correct", support.correct),
    metric("support.accuracy", decimal(support.accuracy)),
    metric("support.falseSupport", support.falseSupport),
    metric("support.missedSupport", support.missedSupport),
    metric("support.undecided", support.undecided),
    metric("support.unjudged", support.unjudged),
  ];
}

/**
 * Renders the information-loss axis.
 *
 * @param report - The report.
 * @returns Its lines.
 */
function informationLossLines(report: EvalReport): string[] {
  const { informationLoss } = report;
  return [
    "[information-loss] extracted work that never reached a decision, or reached a free one",
    metric("informationLoss.candidates", informationLoss.candidates),
    metric("informationLoss.notEvaluated", informationLoss.notEvaluated),
    metric("informationLoss.pending", informationLoss.pending),
    metric("informationLoss.failed", informationLoss.failed),
    metric("informationLoss.freeWhenLabelExisted", informationLoss.freeWhenLabelExisted),
    metric("informationLoss.lossRate", decimal(informationLoss.lossRate)),
  ];
}

/**
 * Renders the extractor-coverage axis.
 *
 * @param report - The report.
 * @returns Its lines.
 */
function coverageLines(report: EvalReport): string[] {
  const { extractorCoverage } = report;
  return [
    "[extractor-coverage] facts the extractor produced at all, over every labeled fact",
    metric("extractorCoverage.labeledFacts", extractorCoverage.labeledFacts),
    metric("extractorCoverage.produced", extractorCoverage.produced),
    metric("extractorCoverage.omitted", extractorCoverage.omitted),
    metric("extractorCoverage.coverageRate", decimal(extractorCoverage.coverageRate)),
    metric("extractorCoverage.omittedIds", extractorCoverage.omittedIds.join(", ") || "(none)"),
  ];
}

/**
 * Renders the report as readable text, with every metric labelled by its axis.
 *
 * @param report - The report to render.
 * @returns The text, without a trailing newline.
 */
export function renderText(report: EvalReport): string {
  const run = reportedRun(report.run);
  const header = [
    "KG ingestion evaluation",
    `set: ${report.setVersion}   catalog: ${report.catalogVersion}`,
    `run: mode=${run.mode}  model=${run.model}  baseUrl=${run.baseUrl ?? "(none)"}`,
  ];
  return [
    ...header,
    "",
    ...classifierLines(report),
    "",
    ...supportLines(report),
    "",
    ...informationLossLines(report),
    "",
    ...coverageLines(report),
    "",
    NO_AGGREGATE_NOTE,
  ].join("\n");
}

/**
 * Renders the report as machine-readable JSON.
 *
 * @param report - The report to render.
 * @returns Indented JSON, without a trailing newline.
 */
export function renderJson(report: EvalReport): string {
  return JSON.stringify({ ...report, run: reportedRun(report.run) }, null, 2);
}
