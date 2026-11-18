/**
 * @file test/dimensions/report-message-order.test.ts
 * @description The orderings of the derived compile line that the acceptance case does not
 * cover, asserted as whole strings.
 *
 * ## Why orderings need their own suite
 *
 * The acceptance case (`Compiled wiki. kg: not part of this route.`) fixes one shape. The
 * line is assembled from two parts — what succeeded, then one clause per dimension that did
 * not — and each part has an ordering claim that a single case cannot pin: the successes are
 * named in canonical order even when the ONLY success is the second dimension, the clause
 * list follows `KNOWN_DIMENSIONS` regardless of why each dimension was skipped, and the
 * reasons must stay distinguishable side by side rather than collapsing into one wording.
 *
 * ## Why exact strings
 *
 * A substring check would pass while a dimension rendered as silence, which is the reported
 * defect. Every assertion here compares the entire line.
 */
import { describe, expect, it } from "vitest";

import {
  describeDimensionMessage,
  describeDimensionOutcomes,
} from "../../packages/wiki/src/dimensions/report.js";

/** The full route: both dimensions composed, which is `POST /api/ingest`. */
const FULL_ROUTE = ["wiki", "kg"] as const;

/** A committed `kg` run, for the case where the SECOND dimension is the only success. */
const KG_COMMITTED = { name: "kg", state: "committed", summary: "kg:ok" } as const;

/**
 * Build the report and render its line in one call, which is how a caller uses it.
 *
 * @param input - The input the report takes.
 * @returns The one-line message derived from it.
 */
function messageOf(input: Parameters<typeof describeDimensionOutcomes>[0]): string {
  return describeDimensionMessage(describeDimensionOutcomes(input));
}

describe("the derived compile line, orderings beyond the acceptance case", () => {
  it("names the ONE success even when it is the second dimension", async () => {
    // `wiki` failed, so the success part must read `Compiled kg.` -- not `Compiled wiki.`
    // with `kg` remembered from array position, and not `Nothing compiled.`.
    const message = messageOf({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [{ name: "wiki", state: "failed", error: "wiki blew up" }, KG_COMMITTED],
    });

    expect(message).toBe("Compiled kg. wiki: failed.");
  });

  it("says nothing is in the route when the route composes nothing", () => {
    // A route that composes no dimension at all is a real case, and the truth is that
    // NEITHER dimension is part of it -- silence would read as "they ran and found nothing".
    const message = messageOf({ route: [], enabled: [...FULL_ROUTE], runs: [] });

    expect(message).toBe(
      "Nothing compiled. wiki: not part of this route. kg: not part of this route.",
    );
  });

  it("keeps `no changes` and `disabled` apart when both appear in one line", () => {
    // The two reasons an operator acts on differently: one means the switch excludes the
    // dimension, the other means it ran and had nothing to write. Collapsing them would send
    // someone to change a setting that was never the cause.
    const message = messageOf({
      route: [...FULL_ROUTE],
      enabled: ["wiki"],
      runs: [{ name: "wiki", state: "declined" }],
    });

    expect(message).toBe("Nothing compiled. wiki: no changes. kg: disabled by LLMWIKI_DIMENSIONS.");
  });

  it("names a run that died before the dimensions as not attempted", () => {
    // The fifth reason, in the exact shape it reaches an operator: the run failed upstream
    // of every dimension, so nothing compiled and nothing can be said about either one
    // beyond that fact.
    const message = messageOf({
      route: [...FULL_ROUTE],
      enabled: [...FULL_ROUTE],
      runs: [],
      attempted: false,
    });

    expect(message).toBe("Nothing compiled. wiki: not attempted. kg: not attempted.");
  });
});
