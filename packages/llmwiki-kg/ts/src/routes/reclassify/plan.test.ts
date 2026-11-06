/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/plan.test.ts
 * @description The decision table a reclassification run applies to one stored
 * row: change it, refresh its versions, leave it alone, or preserve it because
 * the classifier could not answer.
 *
 * WHY THIS IS A SEPARATE, PURE UNIT. These rules are the difference between an
 * auditable history and a log full of rows that record no change, and they are
 * cheaper to pin here than through one HTTP request per case. The database is the
 * wrong place to discover that "same answer twice" wrote a second change row.
 *
 * The four outcomes, and where each comes from in the specs:
 *
 * - `apply / classification_changed` — a different answer (S43: traceable changes);
 * - `apply / versions_refreshed` — the same answer under a new catalog or
 *   classifier version, which is what makes a version sweep converge (S43);
 * - `noop` — the same answer under the same versions, so nothing is written and no
 *   log row is appended (a no-op is not a change);
 * - `preserved_after_failure` — an operational failure over a stored decision
 *   (S25, S45.13), which is never allowed to erase what was already decided.
 */

import { describe, expect, it } from "vitest";

import type { EntityClassificationDecision } from "../../core/classify/types.js";
import { planReclassification } from "./plan.js";
import type { StoredDecision } from "./types.js";

/** The classifier version this run is running as. */
const CONTEXT = Object.freeze({ classifierVersion: "jev-classification/1" });

/** One stored decision, with everything the plan reads. */
function stored(overrides: Partial<StoredDecision> = {}): StoredDecision {
  return {
    classificationState: "classified",
    canonicalType: "Role",
    supportState: "supported",
    catalogVersion: "1.0.0",
    classifierVersion: "jev-classification/1",
    verified: false,
    ...overrides,
  };
}

/** One new decision, defaulting to "the same answer as {@link stored}". */
function decision(overrides: Partial<EntityClassificationDecision> = {}): EntityClassificationDecision {
  return {
    kind: "entity",
    ref: "entity:doc:comite",
    name: "Comité de Cambios",
    classificationState: "classified",
    canonicalType: "Role",
    supportState: "supported",
    reason: null,
    readout: {
      choice: "Role",
      probabilities: { Role: 0.9 },
      confidence: 0.8,
      topProbability: 0.9,
      model: "jev-latest",
    },
    catalogVersion: "1.0.0",
    ...overrides,
  };
}

describe("reclassifying one stored decision", () => {
  it("writes nothing when the classifier answers the same thing twice", () => {
    // Same state, same canonical type, same catalog and classifier version: a
    // second identical run must leave no trace, or the log would grow a row per
    // run that says nothing happened.
    expect(planReclassification(stored(), decision(), CONTEXT)).toEqual({ kind: "noop" });
  });

  it("refreshes the versions when the vocabulary moved but the answer did not", () => {
    const action = planReclassification(stored(), decision({ catalogVersion: "2.0.0" }), CONTEXT);
    expect(action).toEqual({ kind: "apply", reason: "versions_refreshed" });
    const classifierMoved = planReclassification(
      stored({ classifierVersion: "jev-classification/0" }),
      decision(),
      CONTEXT,
    );
    expect(classifierMoved).toEqual({ kind: "apply", reason: "versions_refreshed" });
  });

  it("records a change when the answer differs", () => {
    const moved = planReclassification(
      stored(),
      decision({ canonicalType: "Process" }),
      CONTEXT,
    );
    expect(moved).toEqual({ kind: "apply", reason: "classification_changed" });
    // An abstention replacing a classification is a change too: the row goes from
    // classified to free, which is a different KIND of answer, not a refresh.
    const freed = planReclassification(
      stored(),
      decision({ classificationState: "free_no_match", canonicalType: null, reason: "no_canonical_type_matched" }),
      CONTEXT,
    );
    expect(freed).toEqual({ kind: "apply", reason: "classification_changed" });
  });

  it("records a first decision for a row that never had one", () => {
    const first = planReclassification(
      stored({ classificationState: null, canonicalType: null, catalogVersion: null, classifierVersion: null }),
      decision({ classificationState: "failed", canonicalType: null }),
      CONTEXT,
    );
    // A row with no recorded decision is not "unchanged" against an operational
    // state it never had; the first decision, even a failed one, is a change.
    expect(first).toEqual({ kind: "apply", reason: "first_decision" });
  });

  it("preserves a stored decision when the classifier fails operationally", () => {
    const outage = planReclassification(
      stored(),
      decision({ classificationState: "failed", canonicalType: null, readout: null, reason: "provider 400" }),
      CONTEXT,
    );
    // The row keeps the type it had: an outage is not an answer, and erasing a
    // classification because a socket closed would be a silent regression.
    expect(outage).toEqual({ kind: "preserved_after_failure", operationalState: "failed" });
    const pending = planReclassification(
      stored({ classificationState: "free_uncertain", canonicalType: null }),
      decision({ classificationState: "pending", canonicalType: null, readout: null }),
      CONTEXT,
    );
    expect(pending).toEqual({ kind: "preserved_after_failure", operationalState: "pending" });
  });

  it("stores the operational state when there was no decision to protect", () => {
    const failed = planReclassification(
      stored({ classificationState: "pending", canonicalType: null }),
      decision({ classificationState: "failed", canonicalType: null, readout: null }),
      CONTEXT,
    );
    expect(failed).toEqual({ kind: "apply", reason: "classification_changed" });
    // And a still-unanswered row that fails the same way again changed nothing.
    const same = planReclassification(
      stored({ classificationState: "failed", canonicalType: null }),
      decision({ classificationState: "failed", canonicalType: null, readout: null }),
      CONTEXT,
    );
    expect(same).toEqual({ kind: "noop" });
  });
});
