/**
 * @file test/fixtures/lint-cache-expectation.ts
 * @description The rule table two lint-cache suites expect for the same input.
 *
 * ## Why the expectations are shared rather than retyped
 *
 * Both suites feed the same findings and assert the same aggregated, ordered summary.
 * Retyping it meant two places could disagree about what "correct" is, and the ordering
 * rule is the subtle part: tied counts break by rule name ascending, so a copy that
 * dropped `empty-page` would still pass while the tie-break went unverified.
 *
 * The object is frozen so an assertion cannot accidentally mutate the shared table and
 * change what the next case compares against.
 */

/** One aggregated rule row the cache stores and reads back. */
export interface ExpectedRuleRow {
  readonly rule: string;
  readonly severity: "error" | "warning";
  readonly count: number;
  readonly fileCount: number;
  readonly topFile: string;
  readonly topFileCount: number;
}

/**
 * The rule summary both suites assert, in the order the cache must emit.
 *
 * Order is load-bearing: `broken-wikilink` and `missing-summary` both count 2, so the
 * tie is what proves the rule-name tie-break.
 */
export const EXPECTED_RULE_SUMMARY: readonly ExpectedRuleRow[] = Object.freeze([
  { rule: "broken-wikilink", severity: "error", count: 2, fileCount: 1, topFile: "a.md", topFileCount: 2 },
  { rule: "missing-summary", severity: "warning", count: 2, fileCount: 2, topFile: "a.md", topFileCount: 1 },
  { rule: "empty-page", severity: "warning", count: 1, fileCount: 1, topFile: "c.md", topFileCount: 1 },
]);
