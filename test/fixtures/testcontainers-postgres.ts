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
 * Three suites read the container's default database DIRECTLY instead of provisioning a per-run
 * database (`test/lint-honours-request-env.test.ts`, `test/mcp/stack-id-guard.test.ts`,
 * `test/dimensions/kg-shared-credentials-env-order.test.ts`). Against the old default — the tuned
 * compose instance on 5434 — they found tables there because a human had migrated that server.
 * A container starts EMPTY, so the same suites failed with `relation "stacks" does not exist`,
 * `relation "wiki.review_candidates" does not exist` and `relation "wiki.event_log" does not
 * exist`: the new default was not equivalent to the old one.
 *
 * So a container this run obtained has its default database initialized with the repository's
 * schema ONCE, before its URL is published. The schema is not re-derived here:
 * `applySchema` from `per-run-database.ts` parses `SCHEMA_FILES` out of
 * `scripts/apply-schemas.sh` and applies it with the `postgres` client, which is why no `psql`
 * binary is needed and why this file cannot drift from the file list.
 * {@link prepareContainerDatabase} owns that replay, and skips it when a reused container already
 * carries the schema. The RLS migration in that list creates the `llmwiki_app` role, so it lands
 * on the container as a side effect of the same replay.
 *
 * The OVERRIDE path is deliberately NOT initialized. When `LLMWIKI_TEST_DATABASE_URL` is set, that
 * database belongs to the caller and this run does not own its state; migrating somebody's server
 * because a test harness felt like it is not a fix, it is a hazard.
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
 * ## Why the server runs with durability switched OFF
 *
 * Measured independently: the same 6 files / 80 tests took 12.2–13.3 s on the default-durability
 * container against a recorded 4.33 s baseline on the tuned compose instance. Every per-run database
 * replays fifteen schema files — roughly sixty committing statements — across ~40 test processes,
 * so each commit that waits for the WAL to reach disk is paid forty times over.
 *
 * {@link DURABILITY_COMMAND} is therefore applied through the container command, exactly like the
 * compose instance's own `command:` block. This is safe for one reason only, and it is worth
 * stating: the container is throwaway. Nothing in it outlives the run, reuse re-validates it with
 * `select 1` before publishing it, and a container whose postgres died is discarded rather than
 * trusted. The flags are read BACK from the server (`durabilityReport` in
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

/** The container this run started, kept so teardown can stop it when reuse is off. */
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
    const { container, reused } = await startOrAdoptContainer();
    startedContainer = container;
    return { ok: true, container, reused };
  } catch (error) {
    return {
      ok: false,
      reason: `no ${SHARED_POSTGRES_IMAGE} container could be started (${describe(error)})`,
    };
  }
}

/**
 * Start or adopt the container, prepare its database, and publish its URL.
 *
 * A failure AFTER a container was obtained is FATAL rather than a cue to try something else:
 * falling back to a server a developer happens to run would hide a broken container behind a green
 * run, which is the exact false confidence this feature exists to remove.
 */
async function startContainerHandoff(): Promise<ServerOutcome> {
  const acquired = await acquireContainer();
  if (!acquired.ok) return { ok: false, reason: acquired.reason, fatal: false };
  const container = acquired.container;
  const prepared = await prepareContainerDatabase(container.getConnectionUri());
  if (!prepared.ok) {
    return {
      ok: false,
      reason: `the container's default database could not be prepared (${prepared.detail})`,
      fatal: true,
    };
  }
  console.log(
    `[test-database] ${acquired.reused ? "adopted running" : "started"} ${SHARED_POSTGRES_IMAGE} ` +
      `container ${containerName(container)} on ${container.getConnectionUri()}; ${prepared.detail}`,
  );
  return { ok: true, handoff: containerHandoff(container, acquired.reused) };
}

/**
 * Fall back to a server a developer already has on the documented local port.
 *
 * Authorized and deliberately NOT silent: the log line names the adopted server, because a suite
 * that quietly borrowed someone's database is exactly the false confidence this feature removes.
 * The adopted server is NOT schema-initialized either — same rule as the explicit override: this
 * run did not create it and does not own its state.
 */
async function adoptDocumentedServer(): Promise<ServerOutcome> {
  if (!(await answersQuery(DEFAULT_TEST_DATABASE_URL, PROBE_TIMEOUT_SECONDS))) {
    return {
      ok: false,
      reason: `nothing answers at ${DEFAULT_TEST_DATABASE_URL} either`,
      fatal: false,
    };
  }
  console.log(
    `[test-database] WARNING: adopted the pre-existing server at ${DEFAULT_TEST_DATABASE_URL} ` +
      `instead of starting a container; this run is not isolated from that server`,
  );
  return {
    ok: true,
    handoff: buildHandoff({
      source: "adopted",
      url: DEFAULT_TEST_DATABASE_URL,
      container: null,
      reused: false,
    }),
  };
}

/** Nothing answered: record why, without throwing. The loud failure belongs to the chokepoint. */
function unavailableHandoff(reason: string): TestDatabaseHandoff {
  console.log(`[test-database] unavailable: ${reason}`);
  return buildHandoff({ source: "unavailable", url: null, container: null, reused: false, reason });
}

/**
 * Obtain a database a container provides, or explain why none was obtainable.
 *
 * Container first, then the documented local server, then an `unavailable` record. A container that
 * was obtained but could not be prepared stops here with its own reason, because a fallback would
 * report a healthy run against a server this module never validated.
 */
async function runDecidedHandoff(): Promise<TestDatabaseHandoff> {
  const container = await startContainerHandoff();
  if (container.ok) return container.handoff;
  if (container.fatal) return unavailableHandoff(container.reason);
  const adopted = await adoptDocumentedServer();
  if (adopted.ok) return adopted.handoff;
  return unavailableHandoff(`${container.reason}; ${adopted.reason}`);
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
