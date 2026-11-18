/**
 * @file test/dimensions/report.test.ts
 * @description The per-dimension report, and the one-line compile message derived
 * from it.
 *
 * ## What this suite protects, and why it is not cosmetic
 *
 * An operator's compile said `Wiki compiled.` while production carried
 * `LLMWIKI_DIMENSIONS=wiki,kg`. Nothing was missing from the run: what existed could
 * not DISTINGUISH the three states, because the only per-dimension value the
 * coordinator exposed was a summary per COMMITTED dimension. "Ran and succeeded",
 * "ran and failed" and "did not run" therefore rendered identically -- as nothing.
 * So the cases below are about the states staying apart (S4) and the skip reason
 * being a fact rather than silence (S9, S12).
 *
 * ## Precedence is asserted, not implied
 *
 * `not-in-route` outranks `disabled` on purpose: on a route that does not compose a
 * dimension, that is the fact an operator needs, and an environment that also
 * disables it is a coincidence rather than the cause. The first case that could
 * tempt an implementation the other way is here, with both conditions true at once.
 *
 * ## Exact strings
 *
 * Every message assertion compares whole strings (S10). A substring check would pass
 * for `Compiled wiki.` while the operator's actual complaint -- `kg` rendering as
 * silence -- was still true.
 */
import { describe, expect, it } from "vitest";

import { KNOWN_DIMENSIONS } from "../../packages/wiki/src/dimensions/activation.js";
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

/** A committed `wiki` run, the one record most cases need beside their own. */
const WIKI_COMMITTED: DimensionRunReport = {
  name: "wiki",
  state: "committed",
  summary: "wiki:ok",
};

/**
 * The report entry for one dimension.
 *
 * @param outcomes - Report under test.
 * @param name - Dimension to pull out.
 * @returns The entry, or `undefined` when the report omitted the dimension.
 */
function outcomeFor(
  outcomes: readonly DimensionOutcome[],
  name: DimensionName,
): DimensionOutcome | undefined {
  return outcomes.find((outcome) => outcome.name === name);
}

/**
 * Build the report and its message in one call, which is how it is rendered.
 *
 * @param input - The same input the report takes.
 * @returns The one-line message derived from it.
 */
function messageOf(input: Parameters<typeof describeDimensionOutcomes>[0]): string {
  return describeDimensionMessage(describeDimensionOutcomes(input));
}

describe("describeDimensionOutcomes, which dimensions it names", () => {
  it("reports every known dimension, once, in KNOWN_DIMENSIONS order", () => {
    // The route composes only `kg`, so `wiki` must still appear -- a missing entry
    // is the bug S9 names, and silence is exactly what produced the report.
    const outcomes = describeDimensionOutcomes({ route: ["kg"], enabled: ["kg"], runs: [] });

    expect(KNOWN_DIMENSIONS).toEqual(["wiki", "kg"]);
    expect(outcomes.map((outcome) => outcome.name)).toEqual([...KNOWN_DIMENSIONS]);
  });

  it("reports not-in-route before disabled when both conditions hold", () => {
    const outcomes = describeDimensionOutcomes({ route: ["wiki"], enabled: [], runs: [] });

    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "skipped",
      reason: "not-in-route",
    });
    // `wiki` is in the route and the switch excludes it, so it is `disabled` -- the
    // contrast is what proves the two reasons were not collapsed into one.
    expect(outcomeFor(outcomes, "wiki")).toEqual({
      name: "wiki",
      status: "skipped",
      reason: "disabled",
    });
  });

  it("reports not-in-route even for a dimension that has a committed run", () => {
    // Defensive: a report built over a route that excludes the dimension must not
    // be rescued by a run record that should not exist for it.
    const outcomes = describeDimensionOutcomes({
      route: ["wiki"],
      enabled: [...FULL_ROUTE],
      runs: [WIKI_COMMITTED, { name: "kg", state: "committed", summary: "kg:ok" }],
    });

    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "skipped",
      reason: "not-in-route",
    });
  });
});

describe("describeDimensionOutcomes, the state it reports for a run", () => {
  it("does not throw when a composed, enabled dimension has no run record", () => {
    const outcomes = describeDimensionOutcomes({ route: [...FULL_ROUTE], enabled: [...FULL_ROUTE], runs: [WIKI_COMMITTED] });

    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "skipped",
      reason: "declined",
    });
  });

  it("carries the error text of a run that threw", () => {
    const outcomes = describeDimensionOutcomes({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [WIKI_COMMITTED, { name: "kg", state: "failed", error: "kg commit failed" }],
    });

    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "failed",
      error: "kg commit failed",
    });
  });

  it("reports a run that declined as skipped, and a commit as succeeded", () => {
    const outcomes = describeDimensionOutcomes({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [WIKI_COMMITTED, { name: "kg", state: "declined" }],
    });

    expect(outcomeFor(outcomes, "wiki")).toEqual({
      name: "wiki",
      status: "succeeded",
      summary: "wiki:ok",
    });
    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "skipped",
      reason: "declined",
    });
  });
});

describe("describeDimensionOutcomes, a run that never reached the dimensions", () => {
  it("reports not-attempted, never declined, for a run that never reached the dimension", () => {
    // `attempted: false` is the pre-dispatch failure: nothing was resolved, so the report may
    // not claim `declined` -- "it ran and found nothing to write" -- about a dimension the run
    // never reached.
    const outcomes = describeDimensionOutcomes({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [],
      attempted: false,
    });

    expect(outcomeFor(outcomes, "wiki")).toEqual({
      name: "wiki",
      status: "skipped",
      reason: "not-attempted",
    });
    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "skipped",
      reason: "not-attempted",
    });
  });

  it("keeps not-in-route ahead of not-attempted", () => {
    // Route first, still: a dimension this route does not compose is a fact about the ROUTE,
    // and `not-attempted` would blame a failure for an exclusion that is by design.
    const outcomes = describeDimensionOutcomes({
      route: ["wiki"],
      enabled: [...FULL_ROUTE],
      runs: [],
      attempted: false,
    });

    expect(outcomeFor(outcomes, "kg")).toEqual({
      name: "kg",
      status: "skipped",
      reason: "not-in-route",
    });
    expect(outcomeFor(outcomes, "wiki")).toEqual({
      name: "wiki",
      status: "skipped",
      reason: "not-attempted",
    });
  });
});

describe("describeDimensionMessage, what compiled", () => {
  it("names the dimension that succeeded and the one outside the route", () => {
    const outcomes = describeDimensionOutcomes({
      route: ["wiki"],
      enabled: [...FULL_ROUTE],
      runs: [WIKI_COMMITTED],
    });

    expect(describeDimensionMessage(outcomes)).toBe("Compiled wiki. kg: not part of this route.");
  });

  it("joins two successes with `and` and says nothing else", () => {
    const message = messageOf({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [WIKI_COMMITTED, { name: "kg", state: "committed", summary: "kg:ok" }],
    });

    expect(message).toBe("Compiled wiki and kg.");
  });

});

describe("describeDimensionMessage, why a dimension did not compile", () => {
  it("says nothing compiled, then names every non-succeeded dimension in order", () => {
    const message = messageOf({
      route: ["wiki"],
      enabled: [...FULL_ROUTE],
      runs: [{ name: "wiki", state: "failed", error: "wiki blew up" }],
    });

    expect(message).toBe("Nothing compiled. wiki: failed. kg: not part of this route.");
  });

  it("names the switch as the reason a composed dimension was skipped", () => {
    const message = messageOf({
      route: [...FULL_ROUTE],
      enabled: ["wiki"],
      runs: [WIKI_COMMITTED],
    });

    expect(message).toBe("Compiled wiki. kg: disabled by LLMWIKI_DIMENSIONS.");
  });

  it("names `no changes` for a dimension that declined", () => {
    const message = messageOf({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [{ name: "wiki", state: "declined" }, { name: "kg", state: "declined" }],
    });

    expect(message).toBe("Nothing compiled. wiki: no changes. kg: no changes.");
  });
});
