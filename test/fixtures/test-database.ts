/**
 * @file test/fixtures/test-database.ts
 * @description The one place that decides which database the test suite connects to.
 *
 * ## The trap this module exists to close
 *
 * Every integration fixture needs the same connection string, and the value it must
 * NEVER produce is the empty string. The production code reads
 * `AKS_DATABASE_URL` and treats empty as "unset" (`activation.ts`:
 * `configured === undefined || configured === "" ? kgConfig.DATABASE_URL : configured`),
 * so `process.env.LLMWIKI_TEST_DATABASE_URL ?? ""` does not mean "no database".
 * It means **"use the vendored default"**, which is
 * `postgresql://aks:aks@localhost:5432/aks` -- the PRODUCTION port.
 *
 * Measured before this module existed: seven fixtures wrote that expression. On a
 * machine with nothing listening on 5432 the failure was `ECONNREFUSED 127.0.0.1:5432`,
 * which reads like a missing database. On a machine where production IS reachable it
 * would instead have CONNECTED, and the suite would have run its assertions against
 * operator data. The dangerous case is the quiet one, and only the loud one was
 * observed.
 *
 * ## Why a fallback rather than a required variable
 *
 * The documented local container already listens on 5434, and requiring a variable
 * that every contributor must remember turns "run the tests" into a setup ritual that
 * gets skipped. Falling back to the documented local container makes the default SAFE:
 * a developer with the compose stack up gets a working suite with no exports, and a
 * developer without it gets a failure that names the right port.
 *
 * Override with `LLMWIKI_TEST_DATABASE_URL` to point at any other instance (CI does).
 *
 * ## Why this file imports nothing
 *
 * It is read by fixtures, by global/setup files and by `vitest.config.ts`-adjacent
 * tooling, some of which run before the application's module graph is loadable. A
 * dependency here would make the safe default unavailable exactly where it is needed
 * most.
 */

/** Environment variable a caller sets to point the suite at another database. */
export const TEST_DATABASE_URL_ENV_VAR = "LLMWIKI_TEST_DATABASE_URL";

/**
 * The documented local test container: `llmwiki-kg-db-1`, published on 5434.
 *
 * Deliberately NOT 5432. The vendored default is 5432, so a fallback to it would
 * reintroduce the production-fallback this module exists to prevent.
 */
export const DEFAULT_TEST_DATABASE_URL = "postgresql://aks:aks@localhost:5434/aks";

/**
 * Resolve the connection string every test fixture must use.
 *
 * An empty or whitespace-only override is treated as ABSENT rather than as a value.
 * That is the specific bug being closed: `AKS_DATABASE_URL=""` is not "no database" to
 * the production code, it is "use the production port", so an empty string must never
 * be propagated into an environment a test builds.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns A non-empty connection string, never `""`.
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TEST_DATABASE_URL_ENV_VAR]?.trim() ?? "";
  return override === "" ? DEFAULT_TEST_DATABASE_URL : override;
}
