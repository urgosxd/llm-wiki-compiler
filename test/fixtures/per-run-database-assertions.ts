/**
 * @file test/fixtures/per-run-database-assertions.ts
 * @description The one assertion that says "this suite is talking to a database of
 * its own, not the shared one".
 *
 * WHY THIS IS SHARED. Three suites — `test/lock-postgres.test.ts`,
 * `test/lock-postgres-integration.test.ts` and
 * `test/lock-postgres-crossprocess.test.ts` — take their DSN from
 * `(await perRunDatabase()).url`, and each one has to prove the WIRING: that the
 * handle it got really is a per-run database and not
 * `DEFAULT_TEST_DATABASE_URL` that some fallback quietly handed back. The proof
 * is the same two facts in all three, and it is the premise the rest of each
 * suite stands on: advisory locks are database-scoped, so a suite locking the
 * shared database would prove nothing about isolation.
 *
 * Each caller keeps its own comment explaining what that premise buys IT; only
 * the assertion is shared, so the three cannot drift into proving different
 * things about the same fixture.
 */

import { expect } from "vitest";

import { isPerRunDatabaseName } from "./per-run-database.js";
import { DEFAULT_TEST_DATABASE_URL } from "./test-database.js";

/**
 * Assert that `dsn` names this process's own per-run database.
 *
 * Both halves matter: the name must match the per-run pattern (so it is a
 * database this process created), and it must not be the shared test database
 * (so no fallback silently substituted one).
 *
 * @param dsn - The connection string the suite will hand to every party in it.
 */
export function expectPerRunDatabase(dsn: string): void {
  expect(isPerRunDatabaseName(new URL(dsn).pathname.slice(1))).toBe(true);
  expect(dsn).not.toBe(DEFAULT_TEST_DATABASE_URL);
}
