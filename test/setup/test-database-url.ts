/**
 * @file test/setup/test-database-url.ts
 * @description The worker-side half of the database handoff: make the run's URL visible to suites.
 *
 * This file is wired as `test.setupFiles` in `vitest.config.ts`, which is the only place vitest runs
 * code in EVERY worker BEFORE the first test module is loaded. That ordering is the entire reason it
 * exists: `AKS_DATABASE_URL` is read at import time by modules that build a connection pool, so a
 * value assigned after a suite loads is a value those suites never see.
 *
 * ## Why both variables, and not one
 *
 * `process.env.LLMWIKI_TEST_DATABASE_URL` is what the repository's resolver (`test/fixtures/
 * test-database.ts`) reads. `process.env.AKS_DATABASE_URL` is what production paths that call
 * `createDimensionsDatabase()` with no argument read directly. Publishing the resolved server into
 * only one of them splits the run in two: the code under test writes to the shared server while the
 * per-run database lives on the container. That exact split-brain is documented and was measured in
 * `test/fixtures/per-run-database.ts`; both are assigned here for the same reason.
 *
 * ## Why an explicit override is never overwritten
 *
 * A developer's shell and CI's `LLMWIKI_TEST_DATABASE_URL` both win over anything this run resolved.
 * Empty and whitespace-only values count as ABSENT rather than as a URL — mirroring the resolver —
 * because `""` is not "no database" to the production code, it means "use the vendored default",
 * which is the production port.
 *
 * ## Why nothing is thrown here
 *
 * A missing or `unavailable` handoff is not this file's failure to report: the loud, actionable
 * "no database" error belongs to the database chokepoint that knows which suites need one. A setup
 * file that threw would abort collection for pure unit suites that never touch Postgres.
 */

import { readTestDatabaseHandoff } from "../fixtures/test-database-handoff.js";
import type { TestDatabaseHandoff } from "../fixtures/test-database-handoff.js";
import { TEST_DATABASE_URL_ENV_VAR } from "../fixtures/test-database.js";

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DIMENSIONS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** True when the environment already carries a usable explicit override. */
function hasExplicitOverride(env: NodeJS.ProcessEnv): boolean {
  return (env[TEST_DATABASE_URL_ENV_VAR]?.trim() ?? "") !== "";
}

/** The URL a published record carries, or `undefined` when it recorded none. */
function recordedUrl(record: TestDatabaseHandoff | undefined): string | undefined {
  if (record === undefined) return undefined;
  return record.url === null ? undefined : record.url;
}

/**
 * The URL this worker should adopt: this run's record, unless the caller already overrode it.
 *
 * Split from {@link publishTestDatabaseUrl} so each half stays readable: the export assigns, this
 * function only decides, and fallow reported the combined version as a refactor target.
 */
function overridableUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (hasExplicitOverride(env)) return undefined;
  // Read through the caller's environment: a run that relocated its record
  // (`LLMWIKI_TEST_DB_HANDOFF_FILE`) must be read from the path it published.
  return recordedUrl(readTestDatabaseHandoff(env));
}

/**
 * Publish this run's database URL into the worker environment.
 *
 * @param env - Environment to mutate; defaults to `process.env`.
 * @returns The URL that was published, or `undefined` when the worker keeps whatever it inherited.
 */
export function publishTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const url = overridableUrl(env);
  if (url === undefined) return undefined;
  env[TEST_DATABASE_URL_ENV_VAR] = url;
  env[DIMENSIONS_DATABASE_URL_ENV_VAR] = url;
  return url;
}

publishTestDatabaseUrl();
