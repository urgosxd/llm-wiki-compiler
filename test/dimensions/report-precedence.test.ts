/**
 * @file test/dimensions/report-precedence.test.ts
 * @description The precedence between "this run never reached the dimensions" and the two
 * facts that outrank it, plus the absence of `attempted` meaning `true`.
 *
 * ## Why precedence is worth its own suite
 *
 * `attempted: false` is the pre-dispatch failure: the run died upstream of the dimension
 * work, so nothing about any dimension was resolved. It is tempting to let that flag win
 * everywhere -- it is the newest, loudest fact -- and that would be wrong twice:
 *
 *   - a route that does not compose the dimension (`not-in-route`) makes a claim about the
 *     DESIGN, and `not-attempted` would blame a failure for an exclusion that is by design;
 *   - a switch that excludes it (`disabled`) makes a claim about the CONFIGURATION, and
 *     `not-attempted` would send an operator hunting a failure while the setting is the
 *     answer.
 *
 * Both are facts an operator can act on, and neither becomes false because a run died
 * early. So route outranks switch, switch outranks the flag, and the flag outranks the run
 * records -- the last of which is not a precedence question but a matter of there being no
 * records at all on that path.
 *
 * ## Why absence must equal `true`
 *
 * `attempted` is optional so every existing producer keeps compiling. An optional flag that
 * defaulted to `false` would relabel every settled run in the field as `not attempted`, so
 * the omission is pinned to the `true` answer, and the message for it is pinned to the exact
 * words an operator reads. A substring check would pass on a message that also carried a
 * stray `not attempted` clause, so every assertion below compares a whole string or a whole
 * array.
 */
import { describe, expect, it } from "vitest";

import {
  describeDimensionMessage,
  describeDimensionOutcomes,
} from "../../packages/wiki/src/dimensions/report.js";
import type {
  DimensionOutcome,
  DimensionRunReport,
} from "../../packages/wiki/src/dimensions/report.js";
import type { DimensionName } from "../../packages/wiki/src/dimensions/types.js";

/** The full route: both dimensions composed, which is `POST /api/ingest`. */
const FULL_ROUTE: readonly DimensionName[] = ["wiki", "kg"];

/** A `wiki` run that ran and found nothing to write. */
const WIKI_DECLINED: DimensionRunReport = { name: "wiki", state: "declined" };

/** The same for `kg`, so neither dimension succeeded and the message has two clauses. */
const KG_DECLINED: DimensionRunReport = { name: "kg", state: "declined" };

describe("a run that never reached the dimensions, against the facts that outrank it", () => {
  it("reports not-in-route for a dimension the route does not compose, not not-attempted", () => {
    // The route composes ONLY `kg`, and the run died before the dimensions. `wiki` is still
    // a fact about the ROUTE: blaming the failure would be a false statement about a
    // dimension this route was never going to run.
    const outcomes = describeDimensionOutcomes({
      route: ["kg"],
      enabled: [...FULL_ROUTE],
      runs: [],
      attempted: false,
    });

    expect(outcomes).toEqual<readonly DimensionOutcome[]>([
      { name: "wiki", status: "skipped", reason: "not-in-route" },
      { name: "kg", status: "skipped", reason: "not-attempted" },
    ]);
  });

  it("reports disabled for a dimension the switch excludes, not not-attempted", () => {
    // The route composes both and `LLMWIKI_DIMENSIONS` excludes `kg`, so `disabled` is the
    // answer an operator acts on: no failure to investigate, one setting to change.
    const outcomes = describeDimensionOutcomes({
      route: [...FULL_ROUTE],
      enabled: ["wiki"],
      runs: [],
      attempted: false,
    });

    expect(outcomes).toEqual<readonly DimensionOutcome[]>([
      { name: "wiki", status: "skipped", reason: "not-attempted" },
      { name: "kg", status: "skipped", reason: "disabled" },
    ]);
  });
});

describe("a run that does not say whether the dimensions were reached", () => {
  it("reads exactly as attempted: true, and never as not attempted", () => {
    const withoutFlag = {
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [WIKI_DECLINED, KG_DECLINED],
    };
    const withFlagTrue = { ...withoutFlag, attempted: true };

    // Absence means `true`: the coordinator ran, so the run records are the answer. A
    // default of `false` would have relabelled this every-run case as `not attempted`.
    expect(describeDimensionOutcomes(withoutFlag)).toEqual(describeDimensionOutcomes(withFlagTrue));
    expect(describeDimensionOutcomes(withoutFlag)).toEqual<readonly DimensionOutcome[]>([
      { name: "wiki", status: "skipped", reason: "declined" },
      { name: "kg", status: "skipped", reason: "declined" },
    ]);

    const message = describeDimensionMessage(describeDimensionOutcomes(withoutFlag));
    expect(message).toBe("Nothing compiled. wiki: no changes. kg: no changes.");
    expect(message).not.toContain("not attempted");
  });
});
