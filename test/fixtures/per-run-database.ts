/**
 * @file test/fixtures/per-run-database.ts
 * @description The test-side entry point for per-run database isolation.
 *
 * The implementation is NOT here: it lives in
 * `packages/llmwiki-kg/ts/src/testing/per-run-database.ts`, because the KG package
 * typechecks with `rootDir: "src"` and `src/db.test.ts` has to provision its own
 * database too. A copy in both places would be the same drift the shared fixtures were
 * created to stop, and a copy here would re-break `npm run typecheck:kg` for `db.test.ts`.
 *
 * What this file adds is the only thing the package cannot own: the repository's test
 * database RESOLVER (`test/fixtures/test-database.ts`, whose contract is pinned by
 * `test/test-database-fixture.test.ts`) and the redirection of that resolver at the
 * database this process created.
 *
 * ## Why the redirect
 *
 * Sibling fixtures this task does not own (`test/dimensions/harness-lifecycle.ts`,
 * `test/fixtures/query-stack-root.ts`, and the `test/cli/**` suites) build the
 * environment the code under test receives from `testDatabaseUrl()`. Without the
 * redirect they would hand the code under test a connection string pointing at the
 * shared database while the Stack being tested lives in this process's own one.
 */
import {
  PER_RUN_DATABASE_PREFIX,
  createSuiteDatabase as createSuiteDatabaseOn,
  isPerRunDatabaseName,
  listPerRunDatabases as listPerRunDatabasesOn,
  perRunDatabase as perRunDatabaseOn,
  reapStalePerRunDatabases as reapStalePerRunDatabasesOn,
} from "@repo/kg/testing/per-run-database";
import type { SuiteDatabase } from "@repo/kg/testing/per-run-database";
import { TEST_DATABASE_URL_ENV_VAR, testDatabaseUrl } from "./test-database.js";

export { PER_RUN_DATABASE_PREFIX, isPerRunDatabaseName };
export type { SuiteDatabase };

/**
 * The server this process provisions on, resolved ONCE and remembered.
 *
 * Load-bearing. {@link perRunDatabase} redirects the resolver's override variable at
 * the database it just created, so a later `testDatabaseUrl()` call returns THE SUITE
 * DATABASE, not the server. Re-resolving per call would therefore treat that database
 * as the server, create a SECOND database, and leave one caller reading it while the
 * harness wrote the first one — measured as four `quickstart` failures whose ingest
 * reported success and whose read found zero sources.
 */
let suiteServer: string | undefined;

/** The server URL every call in this process uses. */
function serverUrl(): string {
  suiteServer ??= testDatabaseUrl();
  return suiteServer;
}

/** Create one database on the test server and build the schema in it. */
export async function createSuiteDatabase(label: string): Promise<SuiteDatabase> {
  return createSuiteDatabaseOn(serverUrl(), label);
}

/** Every per-run database on the test server, debris included. */
export async function listPerRunDatabases(): Promise<string[]> {
  return listPerRunDatabasesOn(serverUrl());
}

/** Drop per-run databases older than the fixture's staleness window. */
export async function reapStalePerRunDatabases(now?: number): Promise<string[]> {
  return reapStalePerRunDatabasesOn(serverUrl(), now);
}

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DIMENSIONS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/**
 * This process's database, created on first call.
 *
 * The created database's URL is published TWICE, and both are load-bearing:
 *
 * - `LLMWIKI_TEST_DATABASE_URL`, the resolver's override, so every later
 *   `testDatabaseUrl()` call in this process — including the ones in fixtures outside
 *   this task's surfaces — resolves to the suite database.
 * - `AKS_DATABASE_URL`, which `vitest.config.ts` seeds for every worker and which
 *   production paths that call `createDimensionsDatabase()` with NO argument read
 *   straight from the environment. MEASURED: leaving it at the shared value made
 *   `rows-only-review-approve.test.ts` and `rows-only-okf-import.test.ts` fail with
 *   `review_candidates_stack_id_fkey`, because the Stack they provisioned lived in the
 *   suite database while the code under test inserted into the shared one.
 */
export async function perRunDatabase(): Promise<SuiteDatabase> {
  const suite = await perRunDatabaseOn(serverUrl());
  process.env[TEST_DATABASE_URL_ENV_VAR] = suite.url;
  process.env[DIMENSIONS_DATABASE_URL_ENV_VAR] = suite.url;
  return suite;
}
