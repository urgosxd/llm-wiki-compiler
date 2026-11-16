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
 * ## Why this file is the ONLY channel, and what it therefore has to carry
 *
 * `vitest.config.ts` used to seed `AKS_DATABASE_URL` into every worker through a static `env`
 * object. Two channels delivered one fact, and they could disagree: the hatch removed nothing from
 * the static seed, so a run that had declared it had no database still handed production code a
 * configured one. Both channels are now one, decided here, so the run's variable and the run's
 * declared state cannot drift apart.
 *
 * One channel means this file must deliver the whole union the two used to deliver between them:
 * the run's recorded URL when the caller gave no override, and otherwise the caller's override — or
 * the documented local default, which is the value the static seed carried for a worker whose
 * record it could not read. That default is deliberately preserved rather than dropped: this change
 * moves the channel, and moving it must not take a value away from a suite that had it.
 *
 * ## Why nothing is thrown here
 *
 * A missing or `unavailable` handoff is not this file's failure to report: the loud, actionable
 * "no database" error belongs to the database chokepoint that knows which suites need one. A setup
 * file that threw would abort collection for pure unit suites that never touch Postgres.
 *
 * ## Why the opt-out REMOVES the DSN instead of merely publishing nothing
 *
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` means one thing: this run has no database. A run without a
 * database has to LOOK like a run without a database to the code under test, so a worker of such a
 * run must hold no database URL at all — not a resolved one, not an override, and not one inherited
 * from the shell that started the run.
 *
 * Until this file enforced that, it enforced nothing about the environment: `vitest.config.ts`
 * seeded `AKS_DATABASE_URL` into EVERY worker through a static `test.env` object, so a hatch run
 * still handed production code a configured database and every "is a database configured" answer in
 * the run was TRUE. Measured: with the hatch set and nothing on the production port, a
 * database-backed suite passed by writing rows to whatever `LLMWIKI_TEST_DATABASE_URL` named — the
 * run reported green while the variable it was told to do without was still there. That static seed
 * is gone now (see above), and the deletion stays: an inherited value is still a value.
 *
 * The ruling is that the hatch is enforced HERE, in the TEST seeding chain, and never by teaching
 * production code about a variable only the suite sets: a run without a database must look like a
 * run without a database to the code under test, not to a predicate that recognised the hatch.
 *
 * So the opt-out is checked FIRST and it DELETES `AKS_DATABASE_URL` rather than skipping the
 * publication: publishing nothing leaves whatever the worker inherited in place, which is the whole
 * defect. Only that one variable goes. `LLMWIKI_TEST_DATABASE_URL` stays exactly as the caller left
 * it, because it is what drives the skip diagnostics and the harnesses' messages, and an
 * unreachable value there is how a developer says "do not reach this server" without a container
 * being started.
 *
 * The hatch wins over an override on purpose: the alternative — refusing to honour the hatch when a
 * URL is also present — would leave two variables disagreeing about whether the run has a database,
 * which is the state that made the hatch mean three things and nothing.
 */

import {
  DATABASE_OPT_OUT_ENV_VAR,
  readTestDatabaseHandoff,
} from "../fixtures/test-database-handoff.js";
import type { TestDatabaseHandoff } from "../fixtures/test-database-handoff.js";
import { TEST_DATABASE_URL_ENV_VAR, testDatabaseUrl } from "../fixtures/test-database.js";

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DIMENSIONS_DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** True when this run declared it has no database at all. */
function databaseOptOut(env: NodeJS.ProcessEnv): boolean {
  return env[DATABASE_OPT_OUT_ENV_VAR]?.trim() === "1";
}

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
 *
 * @returns The URL the run recorded, or `undefined` when the caller overrode it or there is no
 *   record — the two states where the record is not the answer.
 */
function overridableUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (hasExplicitOverride(env)) return undefined;
  // Read through the caller's environment: a run that relocated its record
  // (`LLMWIKI_TEST_DB_HANDOFF_FILE`) must be read from the path it published.
  return recordedUrl(readTestDatabaseHandoff(env));
}

/**
 * Publish this run's database URL into the worker environment. This is the ONLY place that seeds
 * `AKS_DATABASE_URL` into a worker: the runner seeds nothing statically (see the module header).
 *
 * @param env - Environment to mutate; defaults to `process.env`.
 * @returns The URL that was published, or `undefined` when this run declared it has no database.
 */
export function publishTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (databaseOptOut(env)) {
    // The hatch is a statement about the RUN, so it wins over any record, any override and any
    // inherited value: a worker of a run with no database must hold no database URL.
    delete env[DIMENSIONS_DATABASE_URL_ENV_VAR];
    return undefined;
  }
  // The record when the caller gave no override; otherwise the caller's override, or the documented
  // local default — the value the static seed in `vitest.config.ts` used to carry, which is why
  // removing that seed does not take a database away from a worker whose record is absent.
  const url = overridableUrl(env) ?? testDatabaseUrl(env);
  env[TEST_DATABASE_URL_ENV_VAR] = url;
  env[DIMENSIONS_DATABASE_URL_ENV_VAR] = url;
  return url;
}

publishTestDatabaseUrl();
