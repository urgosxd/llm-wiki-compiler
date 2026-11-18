/**
 * @file src/dimensions/report.ts
 * @description Turns what the coordinator recorded about ONE run into the report an
 * operator reads: which dimension succeeded, which was skipped and why, and which
 * failed -- plus the single compile line derived from that report.
 *
 * ## Why the report is derived from run STATE, not from `IngestOutcome.summaries`
 *
 * The reported defect looked like a dropped value. It was not. `summaries` holds one
 * bare string per dimension that COMMITTED, so it can express "ran and succeeded"
 * and nothing else: "ran and failed" and "did not run" are both simply absent, and
 * absent renders as silence. A value that cannot distinguish those cases cannot be
 * the report, so the coordinator records a state per run (see
 * {@link DimensionRunReport}) and this module derives the answer from that state.
 * `summaries` stays as it was, beside the richer record, for its existing readers.
 *
 * ## The facts the report must keep apart
 *
 *   1. This route does not compose the dimension -> `skipped` / `not-in-route`.
 *   2. The route composes it but `LLMWIKI_DIMENSIONS` excludes it -> `disabled`.
 *   3. It ran and returned nothing to commit -> `declined`.
 *   4. The run never reached it at all -> `skipped` / `not-attempted`.
 *
 * A fifth shape is a failure, and it is a different fact again because it carries
 * the error text. Collapsing any two of these is how the original report happened:
 * a `POST /api/compile` run legitimately excludes `kg`, so the correct report for it
 * is `Compiled wiki. kg: not part of this route.` and not `Compiled wiki.`
 *
 * ## Precedence is route first, deliberately
 *
 * When a route does not compose a dimension, that is the fact an operator can act
 * on. Configuration that ALSO disables it is a coincidence, and reporting
 * `disabled by LLMWIKI_DIMENSIONS` there would send someone to change an environment
 * variable that would not have helped.
 *
 * `attempted: false` ranks BELOW both, so an upstream death cannot disguise a route that
 * never composed the dimension (a claim about the design) or a switch that excludes it (a
 * claim about the configuration). It outranks the run records only because a run that was
 * never reached records nothing: `failed` and `declined` both describe a dimension that ran.
 *
 * ## One source of truth for the dimension order
 *
 * {@link KNOWN_DIMENSIONS} is imported from `activation.ts` rather than copied: a
 * second literal list would answer correctly only while the two stayed in step, and
 * a new dimension would then be silently missing from every report -- the same
 * silent omission this module exists to remove.
 */

import { KNOWN_DIMENSIONS } from "./activation.js";
import type {
  DimensionOutcome,
  DimensionOutcomeInput,
  DimensionRunReport,
  DimensionSkipReason,
} from "./outcome.js";
import type { DimensionName } from "./types.js";

/*
 * The report's WIRE shape is declared in `./outcome.ts` and re-exported here, so every
 * importer of this module keeps its names while the declarations stay free of the
 * `KNOWN_DIMENSIONS` import this module needs. The reason is a load cost, not tidiness:
 * `activation.ts` pulls the dimension factories and therefore `@repo/kg`, and the job
 * record type is imported by the viewer and the MCP tools, which must not pay it.
 */
export type {
  DimensionOutcome,
  DimensionOutcomeInput,
  DimensionRunReport,
  DimensionSkipReason,
} from "./outcome.js";

/** How each non-success outcome reads in the compile message. */
const SKIP_TEXT: Readonly<Record<DimensionSkipReason, string>> = {
  "not-in-route": "not part of this route",
  disabled: "disabled by LLMWIKI_DIMENSIONS",
  declined: "no changes",
  "not-attempted": "not attempted",
};

/**
 * Build the per-dimension report for one run.
 *
 * Emits ONE entry per known dimension, always, in {@link KNOWN_DIMENSIONS} order: a
 * dimension missing from the report is indistinguishable from one that was not run,
 * which is the defect this exists to fix.
 *
 * Never throws. A reporting path is read AFTER an ingest has already settled, so an
 * error here would replace the answer with a second failure; a dimension with no run
 * record is reported as `declined` instead.
 *
 * @param input - Route, switch and recorded run state for one run.
 * @returns One outcome per known dimension, in canonical order.
 */
export function describeDimensionOutcomes(
  input: DimensionOutcomeInput,
): readonly DimensionOutcome[] {
  return KNOWN_DIMENSIONS.map((name) => describeOne(name, input));
}

/**
 * Resolve one dimension's outcome, applying the documented precedence.
 *
 * @param name - Dimension to describe.
 * @param input - Route, switch and recorded run state for one run.
 * @returns The single outcome for that dimension.
 */
function describeOne(name: DimensionName, input: DimensionOutcomeInput): DimensionOutcome {
  if (!input.route.includes(name)) return { name, status: "skipped", reason: "not-in-route" };
  if (!input.enabled.includes(name)) return { name, status: "skipped", reason: "disabled" };
  // Below both route and switch, and above the run records: a run that was never reached
  // records nothing, so the two states left are `failed` and `declined`, and both describe a
  // dimension that RAN. Claiming either about a pre-dispatch death is the false answer this
  // reason exists to prevent.
  if (input.attempted === false) return { name, status: "skipped", reason: "not-attempted" };
  const run = input.runs.find((candidate) => candidate.name === name);
  if (run === undefined) return { name, status: "skipped", reason: "declined" };
  if (run.state === "failed") return { name, status: "failed", error: run.error ?? "" };
  if (run.state === "declined") return { name, status: "skipped", reason: "declined" };
  return { name, status: "succeeded", summary: run.summary ?? "" };
}

/**
 * The one compile line a settled run reports.
 *
 * Exactly two parts, in this order: what succeeded, then one clause per dimension
 * that did not, in canonical order. The second part is the point -- a route that
 * legitimately excludes a dimension says so instead of saying nothing.
 *
 * @param outcomes - Report from {@link describeDimensionOutcomes}.
 * @returns For example `Compiled wiki. kg: not part of this route.`
 */
export function describeDimensionMessage(outcomes: readonly DimensionOutcome[]): string {
  const parts = [describeSuccesses(outcomes)];
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded") continue;
    parts.push(`${outcome.name}: ${noteOf(outcome)}.`);
  }
  return parts.join(" ");
}

/**
 * Name the dimensions that succeeded.
 *
 * @param outcomes - Report to summarize.
 * @returns `Compiled wiki.`, `Compiled kg.`, `Compiled wiki and kg.`, or
 *   `Nothing compiled.` when none of them committed.
 */
function describeSuccesses(outcomes: readonly DimensionOutcome[]): string {
  const names = outcomes
    .filter((outcome) => outcome.status === "succeeded")
    .map((outcome) => outcome.name);
  return names.length === 0 ? "Nothing compiled." : `Compiled ${names.join(" and ")}.`;
}

/**
 * Reduce a non-success outcome to the clause text that follows its name.
 *
 * @param outcome - An outcome that is not `succeeded`.
 * @returns `failed`, or the skip reason in the operator's words.
 */
function noteOf(outcome: Exclude<DimensionOutcome, { status: "succeeded" }>): string {
  return outcome.status === "failed" ? "failed" : SKIP_TEXT[outcome.reason];
}
