/**
 * @file test/fixtures/suite-database-ownership.ts
 * @description The two halves every "this suite owns its database" claim needs: obtaining a
 * database of this process's own, and stating from OUTSIDE that the suite got one.
 *
 * ## What duplication this removes
 *
 * Two suites that each had no database of their own —
 * `test/mcp/stack-id-guard.test.ts` and `test/lint-honours-request-env.test.ts` — needed the
 * same first half: provision via `perRunDatabase()`, and route a REJECTED provision through
 * `missingTestDatabase` so the failure keeps its one wording. Written separately they carried
 * 34 identical lines, and a third suite (`test/stack-authority-masquerade.test.ts`) already
 * held a copy of the same skip-reason shape; a fourth would have been a copy of a copy.
 * {@link ownSuiteDatabase} is now the one implementation, and it is the reason the shape
 * cannot drift into a second behaviour.
 *
 * Their two probes — `test/mcp/stack-id-guard-isolation.test.ts` and
 * `test/lint-honours-request-env-isolation.test.ts` — needed the same second half: assert
 * through the environment, which is the public interface the production code reads, that
 * `AKS_DATABASE_URL` names a database this very process minted and neither documented shared
 * value. That was 17 identical lines of assertions. {@link expectOwnedSuiteDatabase} states
 * the rule once, so the two probes cannot end up proving different things about the same
 * fixture.
 *
 * ## Why the probe reads the environment and not the mechanism
 *
 * `createDimensionsDatabase(process.env)` and the no-argument `createDimensionsDatabase()`
 * call inside the linter both read `AKS_DATABASE_URL` at call time. That variable is therefore
 * the whole contract, and a probe that called the provisioning helper itself would prove the
 * helper works while saying nothing about where the suite points — and would keep passing
 * after a rewrite that redirected the suite somewhere else. The assertions below are about the
 * VALUE the suite will read, so they survive a rewrite of the mechanism that produces it.
 */

import { expect } from "vitest";

import {
  PER_RUN_DATABASE_PREFIX,
  isPerRunDatabaseName,
  perRunDatabase,
} from "./per-run-database.js";
import { DEFAULT_TEST_DATABASE_URL } from "./test-database.js";
import { missingTestDatabase } from "./test-database-handoff.js";

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DIMENSIONS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/**
 * The vendored production default, which a test worker must never hold.
 *
 * Restated rather than imported: it is the value `activation.ts` falls back to when no DSN is
 * configured, and it is deliberately the PRODUCTION port, so importing the value would be
 * importing production config into a test fixture.
 */
const PRODUCTION_DEFAULT_DATABASE_URL = "postgresql://aks:aks@localhost:5432/aks";

/**
 * Make this process's `AKS_DATABASE_URL` point at a database this process minted.
 *
 * MODULE SCOPE, not a hook: the suites that call this read their connection string while the
 * module graph loads and inside test bodies that may be collected before any hook runs, so the
 * redirect has to have happened by the time this function resolves.
 *
 * A rejected provision never falls back to the server the run shares: that fallback is the
 * defect the per-run database exists to remove, because a suite that degrades to shared state
 * reports green for a reason nobody can see. The decision belongs to `missingTestDatabase`, the
 * one place that words it, so it THROWS unless `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is set — and
 * that opt-out still prints its reason rather than skipping silently.
 *
 * @param context - What needed the database, phrased for the person reading the failure. Pass
 *   the CALLER's path, so the failure points at the suite and not at a fixture.
 * @returns `""` when the database is usable, otherwise the reason the caller's skip reports.
 * @throws When no database can be obtained and the documented opt-out is not set.
 */
export async function ownSuiteDatabase(context: string): Promise<string> {
  try {
    await perRunDatabase();
    return "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = missingTestDatabase(context, detail);
    if (missing.error !== undefined) throw missing.error;
    // Loud, because a skip is reported as a pass: the reason has to be readable in the log
    // even though the case itself contributes no failure line.
    console.warn(missing.message);
    return missing.message;
  }
}

/**
 * Assert that `dsn` names a database this process minted, and no shared server.
 *
 * Every assertion here is one fact the surrounding suite's claim rests on, and dropping any of
 * them would let a different failure pass as isolation:
 *
 *  - not the production port, and not the documented test server, so no fallback quietly
 *    substituted a shared value;
 *  - non-empty, because `""` is not "no database" to production code, it is the vendored
 *    default;
 *  - the per-run NAME PATTERN, not merely its prefix, so a database this module did not mint
 *    cannot pass as one;
 *  - this process's own pid inside the name, which is what "owns it" means observably.
 *
 * @param dsn - The connection string the suite's own code will read; defaults to the value
 *   currently in the environment, which is what the production code reads.
 */
export function expectOwnedSuiteDatabase(
  dsn: string | undefined = process.env[DIMENSIONS_DATABASE_URL_ENV_VAR],
): void {
  const connection = dsn ?? "";

  expect(connection).not.toBe(PRODUCTION_DEFAULT_DATABASE_URL);
  expect(connection).not.toBe(DEFAULT_TEST_DATABASE_URL);
  expect(connection).not.toBe("");

  const name = new URL(connection).pathname.replace(/^\//, "");
  expect(name.startsWith(PER_RUN_DATABASE_PREFIX)).toBe(true);
  // The pattern, not just the prefix: a name this module did not mint is not isolation.
  expect(isPerRunDatabaseName(name)).toBe(true);
  // Ownership, readable from the name: this process is the one that created it.
  expect(name.split("_")[3]).toBe(String(process.pid));
}
