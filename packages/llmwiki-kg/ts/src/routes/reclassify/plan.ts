/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/plan.ts
 * @description What one run does with one stored decision: write it, refresh its
 * versions, leave it alone, or preserve it because the classifier could not answer.
 *
 * ## Why this decision lives in its own function
 *
 * Four different outcomes are reachable for a selected row, and three of them are
 * easy to get silently wrong:
 *
 * - **A no-op must write nothing.** Recording "same answer, same versions" as a change
 *   would fill the append-only log with rows that describe no change, and the next
 *   reader of that log could not tell a real decision change from a re-run (S43).
 * - **A version refresh is not a classification change.** When the vocabulary or the
 *   classifier moved and the answer did not, the row's version columns must move so
 *   the sweep converges, but there is no change to explain, so no history row is
 *   appended. The row itself records the version it was decided under.
 * - **An operational failure must not overwrite a decision.** `pending` and `failed`
 *   are states of the PIPELINE, not answers about the fact (S25). Erasing a stored
 *   `classified` because a socket closed would lose a type the graph had established,
 *   so a failure over a real decision preserves it and is recorded as such (S45.13).
 *
 * ## What counts as "the same answer"
 *
 * The classification state and the canonical type. Semantic support is deliberately
 * excluded: a reclassification run never re-judges the source, it passes the stored
 * `support_state` through, so support cannot move here. If it ever does, that is a
 * refresh of the row — not a change of classification — and the caller still keeps
 * the classification it had.
 */

import type { CandidateDecision } from "../../core/classify/types.js";
import type { OperationalState } from "../../core/jev/types.js";
import type { ClassificationState } from "../../schema-open-classification.js";
import type { StoredDecision } from "./types.js";

/** Everything a plan needs besides the two decisions it compares. */
export interface PlanContext {
  /** Our label for the classifier stage this run is running as. */
  readonly classifierVersion: string;
}

/** Why a row is being written. */
export type ReclassifyApplyReason =
  /** A different state or canonical type: a real change, appended to the log. */
  | "classification_changed"
  /** The same answer under a new catalog or classifier version: no history row. */
  | "versions_refreshed"
  /** The row never held a decision, so this is its first one. */
  | "first_decision";

/** What one run does with one row. */
export type ReclassifyAction =
  | { readonly kind: "apply"; readonly reason: ReclassifyApplyReason }
  | { readonly kind: "noop" }
  | { readonly kind: "preserved_after_failure"; readonly operationalState: OperationalState };

/** The three states that mean "a decision was made and stored". */
const DECIDED_STATES: readonly (ClassificationState | null)[] = [
  "classified",
  "free_no_match",
  "free_uncertain",
];

/**
 * Whether a stored state is a real decision about the fact.
 *
 * @param state - The stored classification state, or `null` when none was recorded.
 * @returns True for the three classification outcomes, false for the operational ones.
 */
export function hasDecision(state: ClassificationState | null): boolean {
  return DECIDED_STATES.includes(state);
}

/**
 * Whether a new state is an operational condition rather than an answer.
 *
 * @param state - The state the classifier ended in.
 * @returns True for `pending` and `failed`.
 */
function isOperational(state: ClassificationState): state is OperationalState {
  return state === "pending" || state === "failed";
}

/**
 * The action for one selected row.
 *
 * @param stored - The decision storage holds right now.
 * @param decision - The decision this run produced.
 * @param context - The classifier version this run is running as.
 * @returns Which of the four outcomes applies.
 */
export function planReclassification(
  stored: StoredDecision,
  decision: CandidateDecision,
  context: PlanContext,
): ReclassifyAction {
  if (isOperational(decision.classificationState) && hasDecision(stored.classificationState)) {
    return { kind: "preserved_after_failure", operationalState: decision.classificationState };
  }
  const sameAnswer =
    stored.classificationState === decision.classificationState &&
    stored.canonicalType === decision.canonicalType;
  const sameVersions =
    stored.catalogVersion === decision.catalogVersion &&
    stored.classifierVersion === context.classifierVersion;
  if (sameAnswer && sameVersions) return { kind: "noop" };
  if (sameAnswer) return { kind: "apply", reason: "versions_refreshed" };
  return {
    kind: "apply",
    reason: stored.classificationState === null ? "first_decision" : "classification_changed",
  };
}
