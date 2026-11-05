/**
 * @file test/fixtures/test-database-handoff.ts
 * @description The one channel a vitest `globalSetup` can use to hand a database URL to workers.
 *
 * ## Why a file, and not `process.env`
 *
 * The container is started ONCE per run, in the main process (`globalSetup`). Test files run in
 * WORKER processes, and a worker is forked from the vitest CLI, not from the setup module, so
 * `process.env.X = …` inside `globalSetup` is invisible to it. The other obvious channel is
 * `config.env` in `vitest.config.ts`, and that one is actively hostile here: it is a STATIC object
 * evaluated for every worker, so whatever it seeds is re-applied in each worker and would clobber a
 * value assigned dynamically.
 *
 * So the resolved URL is written to a small JSON record under `.llmwiki/` (already gitignored) and
 * read back inside each worker by the setup file (`test/setup/test-database-url.ts`), which runs
 * before any test module loads. A file is also the only channel that survives being inspected after
 * the fact: when a run goes wrong, the record says which server the run actually used.
 *
 * ## Why the path is resolved, and not hard-coded
 *
 * One fixed location for every run means a run that SPAWNS another (the loud-failure probe in
 * `no-database-fails-loudly.test.ts` starts a child vitest) overwrites the record its own parent's
 * workers are reading — and that moved the database under the outer run: the child republished the
 * record pointing at `127.0.0.1:1`, so any worker that booted in that window reported
 * `missingTestDatabase` and the run went red for a reason unrelated to any suite. Measured before the
 * fix: 317 samples of `.llmwiki/test-database.json` taken during one run contained the unreachable
 * URL. {@link testDatabaseHandoffFile} is therefore the ONE place that decides the location, every
 * reader and writer goes through it, and `LLMWIKI_TEST_DB_HANDOFF_FILE` relocates it so a nested run
 * owns a record of its own. Unset, it is the historical `.llmwiki/test-database.json`, so nothing
 * that already reads that file sees a different answer.
 *
 * ## Why the record carries a token and a source
 *
 * A stale record from a previous run is the failure mode this format has to make visible. `token`
 * identifies THIS run, `source` says how the URL was decided (`override`, `container`, `adopted`,
 * `unavailable`), and `version` lets the format change without an old file being misread as a
 * current one. `reused` records whether the container was adopted rather than created, which is the
 * difference between a 1.5 s run and a 0.1 s one.
 *
 * ## Why reading never throws
 *
 * The reader runs in every worker of every suite, including suites with no database at all. A
 * missing record is normal (a single-file run of a pure unit suite still executes global setup, but
 * a caller may run a worker without one), and a corrupt record must not be laundered into "no
 * database configured" silently — it is reported as `undefined` here and turned into a loud,
 * actionable failure by the database chokepoint that owns that message, not by this parser.
 *
 * ## Why the loud failure's TEXT lives here
 *
 * {@link missingTestDatabase} is the one place that words the "no database" failure, so no two
 * chokepoints can drift into different advice. It only DECIDES: the chokepoints probe `select 1`
 * first, because "the server did not answer" (which must fail) and "the server answered but an
 * optional role or table is absent" (which still skips) are different conditions that used to look
 * identical. `packages/llmwiki-kg/ts/src/routes/ingest-harness.ts` is the one caller that cannot use
 * this function — its package compiles with `rootDir: "src"`, so importing a file above `src/` is
 * TS6059 — and restates the same actionable names, which the regression test pins.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_DATABASE_URL_ENV_VAR } from "./test-database.js";

/** Record format version. A record with another version is ignored, never reinterpreted. */
export const TEST_DATABASE_HANDOFF_VERSION = 1;

/**
 * The pinned image a run is expected to start when nothing else supplies a database.
 *
 * Restated rather than imported from `testcontainers-postgres.ts`: that module imports
 * `@testcontainers/postgresql`, and this one is read by EVERY worker (through
 * `test/setup/test-database-url.ts`), including pure unit suites that must not pay for a Docker
 * client. The two strings are the same pinned tag, and `ephemeral-postgres.ts` uses it too.
 */
const PINNED_POSTGRES_IMAGE = "pgvector/pgvector:pg16";

/**
 * The one documented opt-out: it restores the pre-fix skip behavior, and it is the ONLY way a run
 * without a database may report green.
 *
 * Restated here for the same reason as {@link PINNED_POSTGRES_IMAGE}: the chokepoints import this
 * module, and it must stay cheap to load in every worker.
 */
export const DATABASE_OPT_OUT_ENV_VAR = "LLMWIKI_TEST_ALLOW_NO_DATABASE";

/** Repository root, resolved from this file so the record is found from any working directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The variable that relocates the record, so a nested run can own one of its own.
 *
 * Only the loud-failure probe is expected to set it; a developer or CI run leaves it alone and keeps
 * the historical location.
 */
export const TEST_DATABASE_HANDOFF_FILE_ENV_VAR = "LLMWIKI_TEST_DB_HANDOFF_FILE";

/** The record's default location, inside `.llmwiki/`, which is gitignored. */
export const DEFAULT_TEST_DATABASE_HANDOFF_FILE = path.join(
  REPOSITORY_ROOT,
  ".llmwiki",
  "test-database.json",
);

/**
 * The record path THIS run reads and writes.
 *
 * A relative override is resolved against the repository root rather than the current working
 * directory, so one value means one file whether the caller is the main process, a worker, or a
 * nested run started elsewhere.
 *
 * @param env - Environment to read the location from; defaults to `process.env`.
 * @returns An absolute path, never an empty string.
 */
export function testDatabaseHandoffFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TEST_DATABASE_HANDOFF_FILE_ENV_VAR]?.trim() ?? "";
  if (override === "") return DEFAULT_TEST_DATABASE_HANDOFF_FILE;
  return path.resolve(REPOSITORY_ROOT, override);
}

/**
 * How this run decided its database URL.
 *
 * - `override` — an explicit `LLMWIKI_TEST_DATABASE_URL` won; no container was started.
 * - `container` — a pgvector container was started (or adopted, see `reused`) for this run.
 * - `adopted` — no container could be obtained, but a server already listening on the documented
 *   local port answered, so it was adopted with a logged warning. Never silent.
 * - `unavailable` — nothing answered. `reason` says why; the failure belongs to the chokepoint.
 */
export type TestDatabaseSource = "override" | "container" | "adopted" | "unavailable";

/** The published facts about the run's database. */
export interface TestDatabaseHandoff {
  /** {@link TEST_DATABASE_HANDOFF_VERSION} at the time of writing. */
  readonly version: number;
  /** Per-run identifier, so a stale record is recognisable from its contents. */
  readonly token: string;
  /** ISO timestamp of resolution, for correlating a record with a run. */
  readonly createdAt: string;
  /** How the URL was decided. */
  readonly source: TestDatabaseSource;
  /** The URL workers must use, or `null` when no database could be resolved. */
  readonly url: string | null;
  /** The container this run used or created, when there is one. */
  readonly container: { readonly id: string; readonly name: string } | null;
  /** True when an already-running container was adopted instead of created. */
  readonly reused: boolean;
  /** Why the database is unavailable. Present only for `source: "unavailable"`. */
  readonly reason?: string;
}

/** Everything a caller decides; identity and timestamp are added by {@link buildHandoff}. */
export type TestDatabaseDecision = Omit<TestDatabaseHandoff, "version" | "token" | "createdAt">;

/** A fresh per-run token. */
export function newHandoffToken(): string {
  return randomBytes(8).toString("hex");
}

/** Complete a decision with the run identity this record format requires. */
export function buildHandoff(decision: TestDatabaseDecision): TestDatabaseHandoff {
  return {
    version: TEST_DATABASE_HANDOFF_VERSION,
    token: newHandoffToken(),
    createdAt: new Date().toISOString(),
    ...decision,
  };
}

/**
 * Publish the record for this run's workers. Creates the record's directory when it is missing.
 *
 * @param handoff - The record to publish.
 * @param env - Environment to read the location from; defaults to `process.env`.
 */
export function writeTestDatabaseHandoff(
  handoff: TestDatabaseHandoff,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = testDatabaseHandoffFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
}

/**
 * Read this run's record.
 *
 * @param env - Environment to read the location from; defaults to `process.env`.
 * @returns The record, or `undefined` when it is absent, unreadable, or of another version.
 */
export function readTestDatabaseHandoff(
  env: NodeJS.ProcessEnv = process.env,
): TestDatabaseHandoff | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(testDatabaseHandoffFile(env), "utf8"));
    return isTestDatabaseHandoff(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a database chokepoint must do when the database it needs cannot be obtained.
 *
 * `error` and `optedOut` are deliberately not one value: the opt-out path still has to explain
 * itself on stderr, so the message is returned whether or not it is thrown.
 */
export interface MissingTestDatabase {
  /** The failure to raise, or `undefined` when the opt-out authorizes the old skip behavior. */
  readonly error: Error | undefined;
  /** True when `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` was set for this run. */
  readonly optedOut: boolean;
  /** The actionable message, naming what is missing and every way to supply it. */
  readonly message: string;
}

/**
 * Decide what a chokepoint does when no database can be obtained.
 *
 * ## Why this is a decision and not a bare `throw`
 *
 * Two different conditions used to look identical, and conflating them is the whole bug: the
 * database being UNOBTAINABLE (which must fail loudly, because a skip is a green that asserts
 * nothing) is not the same as the database being up while an optional object is absent — a missing
 * `llmwiki_app` role, a missing `wiki.pages` table — which stays a skip. Callers tell them apart by
 * probing `select 1` before calling this: reaching here at all means the server did not answer.
 *
 * @param context - What needed the database, phrased for the person reading the failure.
 * @param detail - The observed failure: the connection error, or why a per-run database failed.
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The message, whether the opt-out authorizes skipping, and the error to throw.
 */
export function missingTestDatabase(
  context: string,
  detail: string,
  env: NodeJS.ProcessEnv = process.env,
): MissingTestDatabase {
  const message = noDatabaseMessage(context, detail, readTestDatabaseHandoff(env));
  const optedOut = env[DATABASE_OPT_OUT_ENV_VAR]?.trim() === "1";
  return { message, optedOut, error: optedOut ? undefined : new Error(message) };
}

/**
 * Compose the one actionable text every chokepoint reports.
 *
 * The recorded `reason` is included when this run's global setup published one: it is the only
 * place that knows WHICH prerequisite failed (no Docker, no reachable server, no image), and a
 * message without it sends the reader to the wrong fix.
 */
function noDatabaseMessage(
  context: string,
  detail: string,
  record: TestDatabaseHandoff | undefined,
): string {
  const recorded = record?.source === "unavailable" ? record.reason : undefined;
  return [
    `${context} needs a Postgres database and none could be obtained.`,
    `Observed: ${detail}`,
    ...(recorded === undefined ? [] : [`Recorded by this run's global setup: ${recorded}`]),
    "Database-backed suites must not skip here: a skip is reported as a pass while asserting nothing.",
    "Supply a database in any of these ways:",
    `  - start Docker, so this run can start its pinned ${PINNED_POSTGRES_IMAGE} container, or`,
    `  - set ${TEST_DATABASE_URL_ENV_VAR} to a reachable Postgres that carries the vector extension, or`,
    `  - set ${DATABASE_OPT_OUT_ENV_VAR}=1 to accept the old skip behavior for this run.`,
  ].join("\n");
}

/**
 * One field rule of the record format, as a predicate over the whole record.
 *
 * A list rather than one long `&&` chain: the single expression it replaces reached cyclomatic
 * complexity 11 and fallow reported it as a refactor target, and a rule that reads one line at a
 * time is also one that can be extended without recounting operators.
 */
const HANDOFF_FIELD_RULES: readonly ((record: Record<string, unknown>) => boolean)[] = [
  record => record.version === TEST_DATABASE_HANDOFF_VERSION,
  record => typeof record.token === "string",
  record => typeof record.createdAt === "string",
  record => isSource(record.source),
  record => isOptionalString(record.url),
  record => record.container === null || isContainer(record.container),
  record => typeof record.reused === "boolean",
];

/** Narrow an unknown JSON value to a plain object whose fields can be inspected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A field that must be a string, or explicitly `null`. */
function isOptionalString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/** Narrow an unknown JSON value to a record this version can trust. */
function isTestDatabaseHandoff(value: unknown): value is TestDatabaseHandoff {
  if (!isRecord(value)) return false;
  return HANDOFF_FIELD_RULES.every(rule => rule(value));
}

/** Narrow an unknown value to one of the documented sources. */
function isSource(value: unknown): value is TestDatabaseSource {
  return (
    value === "override" || value === "container" || value === "adopted" || value === "unavailable"
  );
}

/** Narrow an unknown value to the container descriptor the record publishes. */
function isContainer(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}
