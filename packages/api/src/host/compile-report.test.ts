/**
 * @file src/host/compile-report.test.ts
 * @description The report `POST /api/compile` answers with, built from the counts the run
 * actually produced.
 *
 * ## The gap this closes
 *
 * The HTTP surface was verified with ZERO counts only: a compile that compiled nothing
 * rendered `compiled=0 skipped=0 deleted=0 ...`, so an interpolation bug — a count read from
 * the wrong field, or a total taken from the wrong list — would have been invisible on the
 * one integration-shaped check that existed. These cases use NON-ZERO, MUTUALLY DISTINCT
 * numbers, so a swapped pair cannot pass.
 *
 * ## Why `kg` is asserted here too
 *
 * The acceptance case for the whole feature is that a route which legitimately excludes a
 * dimension SAYS so. `POST /api/compile` is that route, and the report it answers with is
 * this function's output, so the `not-in-route` entry is part of the unit's contract.
 */
import { describe, expect, it } from "vitest";

import type { CompileResult } from "@repo/wiki/utils-types";
import { compileReportOf } from "./compile-report.js";

/**
 * A compile result whose every count is distinct.
 *
 * Distinct on purpose: `compiled=3`, `skipped=1` and `deleted=2` would each be wrong if read
 * from the wrong field, and the three list lengths (`2`, `1`, `1`) are distinct from each
 * other and from the counts.
 */
const NON_ZERO: CompileResult = {
  compiled: 3,
  skipped: 1,
  deleted: 2,
  concepts: ["concept-a", "concept-b"],
  pages: ["page-a"],
  errors: ["error-a"],
};

describe("compileReportOf", () => {
  it("interpolates the non-zero counts of the wiki dimension verbatim", () => {
    const outcomes = compileReportOf(NON_ZERO);

    expect(outcomes).toEqual([
      {
        name: "wiki",
        status: "succeeded",
        summary: "wiki: compiled=3 skipped=1 deleted=2 concepts=2 pages=1 errors=1",
      },
      { name: "kg", status: "skipped", reason: "not-in-route" },
    ]);
  });

  it("reports kg as outside the route rather than omitting it", () => {
    const outcomes = compileReportOf(NON_ZERO);
    const kg = outcomes.find((outcome) => outcome.name === "kg");

    // Named, not silent: this is the sentence that turns "I saw nothing about the graph"
    // into "this route does not run the graph".
    expect(kg).toEqual({ name: "kg", status: "skipped", reason: "not-in-route" });
  });
});
