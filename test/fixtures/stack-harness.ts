/**
 * @file test/fixtures/stack-harness.ts
 * @description One throwaway Stack per test body, torn down whatever the body does.
 *
 * ## Why this is shared rather than defined per suite
 *
 * The identical six-line function existed in several dimension suites, and fallow
 * flagged it as a clone group. The duplication was not harmless: each copy hard-coded
 * its own harness LABEL, so a suite that forgot the try/finally leaked a Stack into
 * the next file's run, and the failure surfaced as an unrelated uniqueness violation.
 *
 * Keeping one copy means the teardown cannot drift from the setup.
 *
 * @example
 * it("writes a page", () => withStack("pages", async (harness) => {
 *   await savePage(harness.db, harness.stackId, page);
 * }));
 */

import { randomUUID } from "node:crypto";

import { createKgPostgresHarness, type KgPostgresHarness } from "./kg-postgres.js";

/** Characters of the random suffix kept in a Stack's label. */
const LABEL_SUFFIX_CHARS = 8;

/**
 * Run `body` against a fresh Stack and retire the Stack afterwards.
 *
 * Cleanup runs on both paths, so a failing assertion cannot leave the Stack behind
 * for the next suite in the same database to trip over.
 *
 * @param label - Short suite name; a random suffix keeps `stacks.domain` unique,
 *   which the fixture derives from the harness name.
 * @param body - The test body, given the provisioned harness.
 * @returns Whatever `body` produced; kept generic so metadata can be returned.
 */
export async function withStack<T>(
  label: string,
  body: (harness: KgPostgresHarness) => Promise<T>,
): Promise<T> {
  const harness = await createKgPostgresHarness(`${label}-${randomUUID().slice(0, LABEL_SUFFIX_CHARS)}`);
  try {
    return await body(harness);
  } finally {
    await harness.cleanup();
  }
}

/**
 * Bind a suite's label so its bodies read as `withHarness(async (harness) => …)`.
 *
 * Each suite keeps its own label -- which is what makes a leaked Stack traceable to
 * the file that leaked it -- without re-declaring the teardown that used to drift.
 *
 * @param label - Short suite name, unique per file.
 * @returns A one-argument runner for that label.
 */
export function stackHarnessRunner(
  label: string,
): <T>(body: (harness: KgPostgresHarness) => Promise<T>) => Promise<T> {
  return (body) => withStack(label, body);
}

/** A provisioned Stack plus the release that retires it. */
export interface ProvisionedStack {
  /** The Stack's database handle, tenant id, and reachability. */
  readonly harness: KgPostgresHarness;
  /** Retire the Stack. Safe to call once, and safe for `afterEach`. */
  readonly release: () => Promise<void>;
}

/**
 * Provision a Stack for suites that use `beforeEach` / `afterEach` instead of a
 * callback, and hand back the release to call in teardown.
 *
 * The `beforeEach` + `afterEach` pair was the single most duplicated shape in the
 * dimension suites; each copy also re-derived its own label, so the copies drifted.
 *
 * @param label - Short suite name, unique per file.
 * @returns The harness and its release.
 */
export async function provisionStack(label: string): Promise<ProvisionedStack> {
  const harness = await createKgPostgresHarness(`${label}-${randomUUID().slice(0, LABEL_SUFFIX_CHARS)}`);
  return { harness, release: () => harness.cleanup() };
}
