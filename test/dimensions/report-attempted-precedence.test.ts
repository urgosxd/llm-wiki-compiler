/**
 * @file test/dimensions/report-attempted-precedence.test.ts
 * @description `attempted: false` ranks BELOW route and switch, and above the run records
 * that would otherwise claim a success.
 *
 * ## What this file adds to the precedence already pinned next door
 *
 * `report-precedence.test.ts` pins the mechanism with NO run records, which is the shape a
 * pre-dispatch death actually produces. That leaves the harder half unpinned: what the flag
 * does when records DO exist. A run can record a dimension as `committed` and still settle
 * before the dimensions are resolved -- a rolled-back attempt is the measured example -- and
 * a report that preferred the record would announce work the operator cannot see.
 *
 * So every case here carries records that CONTRADICT the flag, plus one dimension excluded
 * by the route or by the switch. The flag must override the records and lose to the
 * exclusion, and each case asserts the rendered line whole: a substring check would pass on
 * a line that also carried a stray success clause, which is the reported defect one shape
 * over.
 */
import { describe, expect, it } from "vitest";

import {
  describeDimensionMessage,
  describeDimensionOutcomes,
} from "../../packages/wiki/src/dimensions/report.js";
import type {
  DimensionOutcome,
  DimensionOutcomeInput,
} from "../../packages/wiki/src/dimensions/outcome.js";
import type { DimensionName } from "../../packages/wiki/src/dimensions/types.js";

/** The full route: both dimensions composed, which is `POST /api/ingest`. */
const FULL_ROUTE: readonly DimensionName[] = ["wiki", "kg"];

/** Two commits that must NOT be read as successes once the run reports `attempted: false`. */
const BOTH_COMMITTED = [
  { name: "wiki", state: "committed", summary: "wiki:ok" },
  { name: "kg", state: "committed", summary: "kg:ok" },
] as const;

/** Both dimensions composed and enabled, records contradicting the pre-dispatch death. */
const BOTH_REACHABLE: DimensionOutcomeInput = {
  route: FULL_ROUTE,
  enabled: FULL_ROUTE,
  runs: BOTH_COMMITTED,
  attempted: false,
};

/** `LLMWIKI_DIMENSIONS=wiki`: the route composes `kg` but the switch excludes it. */
const KG_BY_SWITCH: DimensionOutcomeInput = { ...BOTH_REACHABLE, enabled: ["wiki"] };

/** A route that composes only `kg`, so `wiki` is excluded by design rather than by failure. */
const WIKI_BY_ROUTE: DimensionOutcomeInput = { ...BOTH_REACHABLE, route: ["kg"] };

/**
 * Report and rendered line for one input, which is how a caller uses both together.
 *
 * @param input - The input the report takes.
 * @returns The report, and the one-line message derived from it.
 */
function reportOf(input: DimensionOutcomeInput): {
  readonly outcomes: readonly DimensionOutcome[];
  readonly message: string;
} {
  const outcomes = describeDimensionOutcomes(input);
  return { outcomes, message: describeDimensionMessage(outcomes) };
}

describe("attempted: false, against run records that claim otherwise", () => {
  it("does not rescue a recorded committed run", () => {
    // Without the flag these two records read `Compiled wiki and kg.` With it, nothing was
    // reached, so neither commit can be announced: the records describe an attempt whose
    // work did not survive, and the only truthful answer is that no dimension was reached.
    const report = reportOf(BOTH_REACHABLE);

    expect(report.outcomes).toEqual<readonly DimensionOutcome[]>([
      { name: "wiki", status: "skipped", reason: "not-attempted" },
      { name: "kg", status: "skipped", reason: "not-attempted" },
    ]);
    expect(report.message).toBe("Nothing compiled. wiki: not attempted. kg: not attempted.");
  });

  it("does not disguise a dimension the switch excludes", () => {
    // `LLMWIKI_DIMENSIONS=wiki` excludes `kg`, a fact about the CONFIGURATION that survives
    // the run dying: reporting `not attempted` for it would send an operator hunting a
    // failure while a setting is the whole answer. Both reasons in one line pins
    // `not attempted` and `disabled by LLMWIKI_DIMENSIONS` as distinct clauses.
    const report = reportOf(KG_BY_SWITCH);

    expect(report.outcomes).toEqual<readonly DimensionOutcome[]>([
      { name: "wiki", status: "skipped", reason: "not-attempted" },
      { name: "kg", status: "skipped", reason: "disabled" },
    ]);
    expect(report.message).toBe(
      "Nothing compiled. wiki: not attempted. kg: disabled by LLMWIKI_DIMENSIONS.",
    );
  });

  it("does not disguise a dimension the route never composes", () => {
    // A route that composes only `kg` never runs `wiki`, by design. That is a statement about
    // the route, so it outranks the failure: nothing was attempted for `kg`, and `wiki` was
    // never going to be attempted at all.
    const report = reportOf(WIKI_BY_ROUTE);

    expect(report.outcomes).toEqual<readonly DimensionOutcome[]>([
      { name: "wiki", status: "skipped", reason: "not-in-route" },
      { name: "kg", status: "skipped", reason: "not-attempted" },
    ]);
    expect(report.message).toBe(
      "Nothing compiled. wiki: not part of this route. kg: not attempted.",
    );
  });
});
