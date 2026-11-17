/**
 * @file test/fixtures/testcontainers-postgres.ts
 * @description The shared, reusable pgvector container a whole vitest run talks to.
 *
 * ## What this replaces, and what it does not
 *
 * `test/fixtures/ephemeral-postgres.ts` starts a container a SINGLE suite owns from start to
 * finish, through `docker run`. That is right for one probe and wrong for the whole suite: 1300+
 * files starting their own server would be slower than the database they were avoiding, and each
 * `docker run` costs ~1.5 s even with a cached image.
 *
 * So this module owns ONE server per run, started by `test/global-setup.ts` and shared by every
 * worker. Per-process isolation is NOT reimplemented here: `per-run-database.ts` already creates and
 * drops one database per test process on whichever server it is pointed at, so parallel workers stay
 * independent on a shared container and a reused container cannot leak a dirty database into the
 * next run.
 *
 * The techniques borrowed from `ephemeral-postgres.ts` are the ones that were measured to
 * matter: a pinned image, a Docker-chosen host port (another Postgres already owns 5434 on a
 * developer machine), and a real `select 1` before the URL is published anywhere. The probe itself
 * lives in `container-server-primitives.ts`, so the two fixtures cannot disagree about what
 * "usable" means.
 *
 * ## The shared server also carries the PROJECT SCHEMA, and only the container path gets it
 *
 * The three suites this passage used to name as direct readers of the container's default database
 * are gone from that role: `test/lint-honours-request-env.test.ts` and
 * `test/mcp/stack-id-guard.test.ts` now provision a per-run database of their own through
 * `test/fixtures/suite-database-ownership.ts`, and
 * `test/dimensions/kg-shared-credentials-env-order.test.ts` was deleted in
 * `fec50896056444a1d6ee5886b2dcfbe906385e5c`. They read that database because the old default — the
 * tuned compose instance on 5434 — had tables on it that a human had migrated by hand, and a
 * container starts EMPTY, so they failed with `relation "stacks" does not exist`,
 * `relation "wiki.review_candidates" does not exist` and `relation "wiki.event_log" does not
 * exist`: the new default was not equivalent to the old one.
 *
 * So a container this run obtained has its default database initialized with the repository's
 * schema ONCE, before its URL is published. That is still load-bearing, for two reasons that
 * outlive those suites: the replay is how a container started by THIS run proves the server can
 * take the project schema at all ({@link prepareContainerDatabase} fails loudly rather than
 * publishing a half-built database), and the schema the default database carries is what the
 * ADOPTION GATE below reads — an adopted container is identified by the schema it holds, not by
 * its label. The schema is not re-derived here: `applySchema` from `per-run-database.ts` parses
 * `SCHEMA_FILES` out of `scripts/apply-schemas.sh` and applies it with the `postgres` client, which
 * is why no `psql` binary is needed and why this file cannot drift from the file list. The RLS
 * migration in that list creates the `llmwiki_app` role, so it lands on the container as a side
 * effect of the same replay.
 *
 * The OVERRIDE path is deliberately NOT initialized. When `LLMWIKI_TEST_DATABASE_URL` is set, that
 * database belongs to the caller and this run does not own its state; migrating somebody's server
 * because a test harness felt like it is not a fix, it is a hazard.
 *
 * ## There is no fallback to a server this run did not create
 *
 * When no container can be obtained, this run does NOT continue on whatever answers at
 * `DEFAULT_TEST_DATABASE_URL` — in practice a developer's hand-migrated compose instance on 5434.
 * That fallback used to announce itself with a WARNING and then proceed, which is the worst of both
 * worlds: a log line nobody reads in a suite summary, describing a run that is green against state
 * it never produced and can therefore pass on another run's leftovers. It is now REFUSED:
 * {@link noContainerHandoff} publishes the `unavailable` record with a reason that names the
 * answering server, says this run neither created nor owns it, and states both ways out. The
 * existing chokepoint turns that record into the loud failure, so no second skip mechanism exists.
 * `LLMWIKI_TEST_DATABASE_URL` remains the way to say "yes, that server, on purpose".
 *
 * ## Reuse semantics, measured and not assumed
 *
 * `@testcontainers/postgresql` reuse was probed on this machine before this module relied on it:
 *
 * - Second run ADOPTS the identical container: 1521 ms to create, 120 ms to adopt.
 * - `getConnectionUri()` after adoption still returns the WORKING mapped host port (verified with a
 *   query and against `docker port`), so adoption is not a URL guess.
 * - `stop()` on a reusable container REMOVES it (`autoRemove` defaults to true), which would defeat
 *   reuse entirely. {@link releaseSharedTestDatabase} therefore does not stop it.
 * - Ryuk never sees it: the reuse path skips the `org.testcontainers.session-id` label that the
 *   reaper filters on, so no reaper deletes it when the run ends.
 *
 * Adoption is keyed by a hash of the container creation options, so every option here must stay
 * STATIC. A random name, a per-run label, or a changed port would silently disable reuse by
 * producing a new hash on every run. {@link DURABILITY_COMMAND} is part of that hash, so changing a
 * flag replaces the adopted container rather than reusing one started with other settings.
 *
 * ## Adoption is GATED ON SCHEMA PARITY, measured and not assumed
 *
 * The hash says the container was created by THIS repository's options; it says nothing about which
 * commit built its schema, and `.withReuse()` adopted it unconditionally while
 * `prepareContainerDatabase` skipped the replay for any database that already held the two sentinel
 * tables. Measured consequence: a SEVEN-DAY-OLD labelled container was adopted and served a whole
 * gate run while its default database was missing `wiki.embedding_store_meta.backend` and
 * `wiki.embedding_store_meta.endpoint`, and while `public.stacks` still held a row from that earlier
 * run.
 *
 * So an adopted candidate is prepared and then COMPARED: the columns the registered SQL files
 * declare, parsed by `scripts/schema-parity-check.ts` — the same parser the runner's documented
 * check mode uses — against `information_schema.columns` on the candidate. Matching means adoption
 * keeps its ~120 ms instead of a ~1.5 s create; not matching means {@link adoptedContainerRefusal}
 * names the container and the missing tables/columns and the run publishes an `unavailable` record.
 * The optimisation is kept exactly where it is safe, and nothing is adopted blind.
 *
 * ## Why the server runs with durability switched OFF
 *
 * Measured independently: the same 6 files / 80 tests took 12.2–13.3 s on the default-durability
 * container against a recorded 4.33 s baseline on the tuned compose instance. Every per-run database
 * replays fifteen schema files — roughly sixty committing statements — across ~40 test processes,
 * so each commit that waits for the WAL to reach disk is paid forty times over.
 *
 * {@link DURABILITY_COMMAND} is therefore applied through the container command, exactly like the
 * compose instance's own `command:` block. This is safe for one reason only, and it is worth
 * stating: the container is throwaway. Nothing in it outlives the run beyond the reuse window, and
 * reuse re-validates it before publishing it — `select 1` for liveness and the declared schema for
 * identity — so a container whose postgres died, or whose schema an earlier commit built, is
 * refused rather than trusted. The flags are read BACK from the server (`durabilityReport` in
 * `container-server-primitives.ts`) instead of being assumed accepted, because a rejected `-c` flag
 * is invisible otherwise.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  answersQuery,
  DURABILITY_COMMAND,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  prepareContainerDatabase,
} from "./container-server-primitives.js";
import {
  buildHandoff,
  writeTestDatabaseHandoff,
  type TestDatabaseHandoff,
} from "./test-database-handoff.js";
import { DEFAULT_TEST_DATABASE_URL, TEST_DATABASE_URL_ENV_VAR } from "./test-database.js";

const run = promisify(execFile);

/** The repository's pgvector image, pinned to a major tag exactly as `ephemeral-postgres.ts` does. */
export const SHARED_POSTGRES_IMAGE = "pgvector/pgvector:pg16";

/** The single documented opt-out: restores skip behavior instead of demanding a database. */
export const DATABASE_OPT_OUT_ENV_VAR = "LLMWIKI_TEST_ALLOW_NO_DATABASE";

/** Testcontainers' own reuse switch. Only `"false"` disables reuse. */
const REUSE_DISABLED_ENV_VAR = "TESTCONTAINERS_REUSE_ENABLE";

/** Label every container of this role carries, so debris is findable with one `docker ps`. */
const ROLE_LABEL = "llmwiki.role=shared-test-db";

/** Static creation options. Part of the reuse hash, so nothing here may vary per run. */
const CONTAINER_OPTIONS = {
  labels: { "llmwiki.role": "shared-test-db", "llmwiki.component": "testcontainers-postgres" },
  startupTimeoutMs: 120_000,
} as const;

/** How long a `select 1` may take before the server counts as unreachable. */
const PROBE_TIMEOUT_SECONDS = DEFAULT_PROBE_TIMEOUT_SECONDS;

/**
 * The container this run obtained, prepared and published, so teardown can give it back.
 *
 * Set only once its database was ACCEPTED: a container this run refused is not one it owns, and
 * teardown must not be able to stop it (`stop()` on a reusable container removes it).
 */
let startedContainer: StartedPostgreSqlContainer | undefined;

/** The explicit override, when the caller set one. Empty and whitespace count as absent. */
export function explicitDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[TEST_DATABASE_URL_ENV_VAR]?.trim() ?? "";
  return override === "" ? undefined : override;
}

/** True when the caller asked the suite to run without a database rather than start one. */
export function databaseOptOut(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DATABASE_OPT_OUT_ENV_VAR]?.trim() === "1";
}

/** True unless testcontainers' own switch turned reuse off. */
function reuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REUSE_DISABLED_ENV_VAR] !== "false";
}

/** A message from an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A container's name without Docker's leading slash. */
function containerName(container: StartedPostgreSqlContainer): string {
  return container.getName().replace(/^\//, "");
}

/** Container names already carrying this module's role label, refreshed from Docker. */
async function reusableContainerNames(): Promise<Set<string>> {
  try {
    const { stdout } = await run("docker", [
      "ps",
      "--filter",
      `label=${ROLE_LABEL}`,
      "--format",
      "{{.Names}}",
    ]);
    return new Set(stdout.split("\n").map(line => line.trim()).filter(line => line !== ""));
  } catch {
    return new Set();
  }
}

/** The creation options, rebuilt each time so a fresh start cannot reuse a consumed builder. */
function containerBuilder(): PostgreSqlContainer {
  return new PostgreSqlContainer(SHARED_POSTGRES_IMAGE)
    .withLabels(CONTAINER_OPTIONS.labels)
    .withCommand([...DURABILITY_COMMAND])
    .withStartupTimeout(CONTAINER_OPTIONS.startupTimeoutMs)
    .withReuse();
}

/**
 * Start the shared container, or adopt the identical one an earlier run left running.
 *
 * @throws When no container can be started, or a fresh one publishes no reachable server.
 */
async function startOrAdoptContainer(): Promise<{
  container: StartedPostgreSqlContainer;
  reused: boolean;
}> {
  const before = await reusableContainerNames();
  const container = await containerBuilder().start();
  const reused = before.has(containerName(container));
  if (await answersQuery(container.getConnectionUri(), PROBE_TIMEOUT_SECONDS)) {
    return { container, reused };
  }
  // A reusable container can be running but unusable (dead postgres inside). Recreate rather than
  // publish a URL that answers nothing.
  await container.stop().catch(() => undefined);
  const fresh = await containerBuilder().start();
  if (!(await answersQuery(fresh.getConnectionUri(), PROBE_TIMEOUT_SECONDS))) {
    await fresh.stop().catch(() => undefined);
    throw new Error(`${SHARED_POSTGRES_IMAGE} published no reachable server after a fresh start`);
  }
  return { container: fresh, reused: false };
}

/** Turn a container into the record workers read. */
function containerHandoff(
  container: StartedPostgreSqlContainer,
  reused: boolean,
): TestDatabaseHandoff {
  return buildHandoff({
    source: "container",
    url: container.getConnectionUri(),
    container: { id: container.getId(), name: containerName(container) },
    reused,
  });
}

/** A database this run can use, or the reason it could not have one. */
type ServerOutcome =
  | { readonly ok: true; readonly handoff: TestDatabaseHandoff }
  | { readonly ok: false; readonly reason: string; readonly fatal: boolean };

/** A container this run obtained, or the reason Docker did not provide one. */
type AcquireOutcome =
  | { readonly ok: true; readonly container: StartedPostgreSqlContainer; readonly reused: boolean }
  | { readonly ok: false; readonly reason: string };

/** Obtain the container, converting a Docker failure into a readable reason instead of an abort. */
async function acquireContainer(): Promise<AcquireOutcome> {
  try {
    return { ok: true, ...(await startOrAdoptContainer()) };
  } catch (error) {
    return {
      ok: false,
      reason: `no ${SHARED_POSTGRES_IMAGE} container could be started (${describe(error)})`,
    };
  }
}

/**
 * Why an adopted container is NOT this run's database, in the words the run publishes.
 *
 * The published record is `unavailable`, so the existing chokepoint raises the loud failure; what
 * this text adds is the two facts a reader needs to act: WHICH container was refused and WHAT its
 * database is missing. The container is deliberately left RUNNING — `stop()` on a reusable
 * container REMOVES it, this run never created it, and deleting somebody else's container to get a
 * green run is the same class of defect as adopting it.
 *
 * @param name - The container's Docker name, without the leading slash.
 * @param detail - Why its default database is unusable, as preparation reported it.
 */
export function adoptedContainerRefusal(name: string, detail: string): string {
  return (
    `the adopted container ${name} is not used as this run's database (${detail}). ` +
    `Remove it with "docker rm -f ${name}" so this run starts a container of its own, or set ` +
    `${TEST_DATABASE_URL_ENV_VAR} to the database you mean to run against`
  );
}

/**
 * Start or adopt the container, prepare its database, and publish its URL.
 *
 * A failure AFTER a container was obtained is FATAL rather than a cue to try something else:
 * falling back to a server a developer happens to run would hide a broken container behind a green
 * run, which is the exact false confidence this feature exists to remove. That includes an adopted
 * container whose schema is not the repository's: this run cannot vouch for that state, so it is
 * refused by name instead of published.
 */
async function startContainerHandoff(): Promise<ServerOutcome> {
  const acquired = await acquireContainer();
  if (!acquired.ok) return { ok: false, reason: acquired.reason, fatal: false };
  const container = acquired.container;
  const name = containerName(container);
  const prepared = await prepareContainerDatabase(container.getConnectionUri());
  if (!prepared.ok) {
    return {
      ok: false,
      reason: acquired.reused
        ? adoptedContainerRefusal(name, prepared.detail)
        : `container ${name}'s default database could not be prepared (${prepared.detail})`,
      fatal: true,
    };
  }
  console.log(
    `[test-database] ${acquired.reused ? "adopted running" : "started"} ${SHARED_POSTGRES_IMAGE} ` +
      `container ${name} on ${container.getConnectionUri()}; ${prepared.detail}`,
  );
  startedContainer = container;
  return { ok: true, handoff: containerHandoff(container, acquired.reused) };
}

/**
 * Why a server already answering on the documented local port is NOT this run's database.
 *
 * `answers` is injectable for one reason: the condition this rule is written against (a container
 * that cannot be started, while a server answers anyway) cannot be produced without stopping
 * somebody else's container, so the rule is checked by driving the probe instead.
 */
async function documentedServerRefusal(
  answers: (url: string) => Promise<boolean>,
): Promise<string> {
  if (!(await answers(DEFAULT_TEST_DATABASE_URL))) {
    return `nothing answers at ${DEFAULT_TEST_DATABASE_URL} either`;
  }
  return (
    `a server answers at ${DEFAULT_TEST_DATABASE_URL}, but this run neither created nor owns it, ` +
    `so it is not used as this run's database: start Docker so the run can start its pinned ` +
    `${SHARED_POSTGRES_IMAGE} container, or set ${TEST_DATABASE_URL_ENV_VAR} to that URL if you ` +
    `really mean to run against that server`
  );
}

/** Nothing answered: record why, without throwing. The loud failure belongs to the chokepoint. */
function unavailableHandoff(reason: string): TestDatabaseHandoff {
  console.log(`[test-database] unavailable: ${reason}`);
  return buildHandoff({ source: "unavailable", url: null, container: null, reused: false, reason });
}

/**
 * The record this run publishes when no container could be obtained.
 *
 * There is no adoption: a server this run did not create is reported as unavailable, with a reason
 * that says which server answered and what to do instead. The failure itself belongs to the
 * chokepoint (`missingTestDatabase`), which already words it from the recorded reason.
 *
 * @param containerReason - Why Docker provided no container, kept so both causes are reported.
 * @param answers - Probe for the documented local port; the caller passes the real `select 1`.
 * @returns An `unavailable` record, never one that publishes another run's server.
 */
export async function noContainerHandoff(
  containerReason: string,
  answers: (url: string) => Promise<boolean>,
): Promise<TestDatabaseHandoff> {
  const refusal = await documentedServerRefusal(answers);
  return unavailableHandoff(`${containerReason}; ${refusal}`);
}

/**
 * Obtain a database a container provides, or explain why none was obtainable.
 *
 * Container first, then — when Docker gave nothing — an `unavailable` record that also reports
 * whether a server merely answered on the documented port. A container that was obtained but could
 * not be prepared stops here with its own reason, because a fallback would report a healthy run
 * against a server this module never validated.
 */
async function runDecidedHandoff(): Promise<TestDatabaseHandoff> {
  const container = await startContainerHandoff();
  if (container.ok) return container.handoff;
  if (container.fatal) return unavailableHandoff(container.reason);
  return noContainerHandoff(container.reason, url =>
    answersQuery(url, PROBE_TIMEOUT_SECONDS),
  );
}

/**
 * What the CALLER decided, before any container is considered.
 *
 * @returns The override or opt-out record, or `undefined` when a container should be started.
 */
function callerDecidedHandoff(env: NodeJS.ProcessEnv): TestDatabaseHandoff | undefined {
  const explicit = explicitDatabaseUrl(env);
  if (explicit !== undefined) {
    console.log(`[test-database] ${TEST_DATABASE_URL_ENV_VAR} is set; no container started`);
    return buildHandoff({ source: "override", url: explicit, container: null, reused: false });
  }
  return databaseOptOut(env)
    ? unavailableHandoff(`${DATABASE_OPT_OUT_ENV_VAR}=1, so no container was started`)
    : undefined;
}

/** Decide this run's database, in precedence order, without ever throwing. */
async function resolveHandoff(env: NodeJS.ProcessEnv): Promise<TestDatabaseHandoff> {
  const decided = callerDecidedHandoff(env);
  if (decided !== undefined) return decided;
  return runDecidedHandoff();
}

/**
 * Resolve this run's database and publish it in the handoff record.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The record that was written, for callers that want to report on it.
 */
export async function publishSharedTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestDatabaseHandoff> {
  const handoff = await resolveHandoff(env);
  writeTestDatabaseHandoff(handoff, env);
  return handoff;
}

/**
 * Give back what {@link publishSharedTestDatabase} took, at the end of the run.
 *
 * A reusable container is deliberately LEFT RUNNING: `stop()` removes it, and the whole point of
 * reuse is that the next run adopts it in ~120 ms instead of paying ~1.5 s to create it. Ryuk cannot
 * collect it either, because the reuse path carries no reaper session label. When reuse is switched
 * off, nothing will ever adopt it, so it is stopped and removed here.
 */
export async function releaseSharedTestDatabase(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const container = startedContainer;
  startedContainer = undefined;
  if (container === undefined) return;
  if (reuseEnabled(env)) {
    console.log(`[test-database] keeping reusable container ${containerName(container)} for the next run`);
    return;
  }
  await container.stop().catch(() => undefined);
}
