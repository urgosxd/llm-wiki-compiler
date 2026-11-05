/**
 * @file test/fixtures/container-server-primitives.ts
 * @description What every Postgres-container fixture does to a throwaway server, in one place.
 *
 * ## Why this module exists
 *
 * `ephemeral-postgres.ts` (one suite owns a container from start to finish) and
 * `testcontainers-postgres.ts` (one container per test run, shared by every worker) start
 * their servers differently ON PURPOSE, but they must agree on what a USABLE server is.
 * Both used to carry their own copy of that probe, and fallow reported the pair as a
 * 27-line clone group. Two copies of a readiness check drift in the one direction that
 * matters — one of them ends up accepting a server the other rejects — so the probe lives
 * here and both import it.
 *
 * The rest of this file is the same idea one level up. A container fixture has to do three
 * things to the server it owns, and each one is a trap on its own:
 *
 * - decide that the server answers ({@link answersQuery}, {@link waitUntilReady});
 * - decide that its durability settings are the throwaway ones ({@link durabilityReport}),
 *   because a rejected `-c` flag is otherwise invisible;
 * - decide that it carries the project schema ({@link prepareContainerDatabase}), because a
 *   fresh Postgres has none and a reused one may have been built by an older image.
 *
 * ## What is deliberately NOT here
 *
 * No Docker image name, no container lifecycle, no reuse hash, no teardown, no vitest
 * awareness. A caller that owns exactly one container and a caller that shares one can both
 * use these primitives without inheriting the other's ownership rules.
 */

import { setTimeout as sleep } from "node:timers/promises";

import postgres from "postgres";

import {
  applySchema,
  withClient,
} from "../../packages/llmwiki-kg/ts/src/testing/per-run-database.js";

/** How long a probe may spend connecting before the server counts as unreachable. */
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 3;

/** How long to wait for a server that is still starting, and how to ask again meanwhile. */
export interface ReadinessBudget {
  /** Total time the server has to start answering. */
  readonly timeoutMs: number;
  /** How long to wait between two probes. */
  readonly pollMs: number;
  /** Per-probe connect timeout, in seconds. */
  readonly connectTimeoutSeconds: number;
}

/** The durability settings a throwaway Postgres server should run with. */
export interface DurabilitySetting {
  /** `pg_settings.name`, and the `-c` key. */
  readonly name: string;
  /** The value the server must report for the flag to count as applied. */
  readonly expected: string;
}

/**
 * Server settings that trade crash durability for replay speed.
 *
 * These are the values a test database wants and a production one must never have: a crash
 * may lose the last commits, and a torn page is not repaired. Both are irrelevant for a
 * container a test run started, and both are why a manually tuned compose instance is ~3x
 * faster at replaying the schema than a default container.
 */
export const DURABILITY_SETTINGS: readonly DurabilitySetting[] = [
  { name: "fsync", expected: "off" },
  { name: "synchronous_commit", expected: "off" },
  { name: "full_page_writes", expected: "off" },
  { name: "wal_level", expected: "minimal" },
  { name: "max_wal_senders", expected: "0" },
];

/**
 * The container command that applies {@link DURABILITY_SETTINGS}.
 *
 * `postgres` first, because the image's entrypoint dispatches on it: this argument vector is
 * handed to `docker-entrypoint.sh`, which also runs its temporary initdb server with it.
 */
export const DURABILITY_COMMAND: readonly string[] = [
  "postgres",
  ...DURABILITY_SETTINGS.flatMap(setting => ["-c", `${setting.name}=${setting.expected}`]),
];

/**
 * Tables whose presence proves a database already carries the project schema.
 *
 * A two-name probe, NOT a second copy of the schema file list: that list is parsed out of
 * `scripts/apply-schemas.sh` by {@link applySchema}, which is the one implementation reused
 * here. These are the tables database-backed suites were observed to fail on, so they are
 * what "already initialized" means.
 */
const SCHEMA_SENTINELS = ["public.stacks", "wiki.event_log"] as const;

/** A message from an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True once `url` accepts a trivial query.
 *
 * ONE attempt, never a retry: a caller waiting for a server that is still starting uses
 * {@link waitUntilReady}. `connectTimeoutSeconds` is a parameter rather than a constant
 * because the two callers genuinely differ — a supervised container probe waits less than a
 * shared-container health check — and flattening them would silently change one caller.
 *
 * @param url - Connection string to probe.
 * @param connectTimeoutSeconds - How long the TCP connect may take, in seconds.
 * @returns True when the server answered `select 1`, false for any failure at all.
 */
export async function answersQuery(
  url: string,
  connectTimeoutSeconds: number = DEFAULT_PROBE_TIMEOUT_SECONDS,
): Promise<boolean> {
  const client = postgres(url, {
    max: 1,
    connect_timeout: connectTimeoutSeconds,
    onnotice: () => undefined,
  });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Wait until the server answers, or fail naming the container that never came up.
 *
 * @param url - Connection string to probe.
 * @param label - How to name the server in the failure, e.g. the container name.
 * @param budget - Total wait, poll interval and per-probe connect timeout.
 */
export async function waitUntilReady(
  url: string,
  label: string,
  budget: ReadinessBudget,
): Promise<void> {
  const deadline = Date.now() + budget.timeoutMs;
  while (Date.now() < deadline) {
    if (await answersQuery(url, budget.connectTimeoutSeconds)) return;
    await sleep(budget.pollMs);
  }
  throw new Error(`${label} did not accept connections within ${String(budget.timeoutMs)} ms`);
}

/** What the server itself reports for {@link DURABILITY_SETTINGS}. */
export interface DurabilityReport {
  /** True when every setting reads back at exactly the requested value. */
  readonly applied: boolean;
  /** `name=value` pairs as the server reports them, for the run log. */
  readonly summary: string;
}

/** Turn the server's answers into a pass/fail verdict and one log line. */
export function summarizeDurability(values: Record<string, string>): DurabilityReport {
  const applied = DURABILITY_SETTINGS.every(setting => values[setting.name] === setting.expected);
  const summary = DURABILITY_SETTINGS.map(
    setting => `${setting.name}=${values[setting.name] ?? "unreadable"}`,
  ).join(" ");
  return { applied, summary };
}

/** The log text for a durability report: a plain summary, or a warning when the flags were lost. */
export function describeDurability(report: DurabilityReport): string {
  return report.applied
    ? report.summary
    : `WARNING: durability flags did not take effect: ${report.summary}`;
}

/** Read the durability settings back from the server, one query per setting. */
export async function durabilityReport(url: string): Promise<DurabilityReport> {
  const read = await withClient(url, async client => {
    const values: Record<string, string> = {};
    for (const { name } of DURABILITY_SETTINGS) {
      const rows = await client<{ value: string }[]>`
        select current_setting(${name}) as value
      `;
      values[name] = rows[0]?.value ?? "unreadable";
    }
    return values;
  });
  return summarizeDurability(read);
}

/** Does the database behind `url` already carry the project schema? */
export async function schemaPresent(url: string): Promise<boolean> {
  const rows = await withClient(url, client =>
    client<{ name: string }[]>`
      select table_schema || '.' || table_name as name
      from information_schema.tables where table_schema in ('public', 'wiki')
    `,
  );
  const present = new Set(rows.map(row => row.name));
  return SCHEMA_SENTINELS.every(table => present.has(table));
}

/** Outcome of preparing a server's database: either it is usable, or why it is not. */
export interface PrepareOutcome {
  readonly ok: boolean;
  /** The durability summary on success, the failure otherwise. */
  readonly detail: string;
}

/**
 * Make a container's default database usable, and report what the server says about itself.
 *
 * The schema replay is SKIPPED when the sentinels are already there, so an adopted container
 * costs one cheap query instead of fifteen round trips, and a container started by this run
 * pays the replay exactly once. {@link applySchema} is idempotent either way; the check is
 * what keeps reuse fast.
 *
 * @param url - The container's default database, as the superuser role.
 * @returns The durability summary, or the reason preparation failed.
 */
export async function prepareContainerDatabase(url: string): Promise<PrepareOutcome> {
  try {
    const durability = await durabilityReport(url);
    if (!(await schemaPresent(url))) await withClient(url, applySchema);
    return { ok: true, detail: describeDurability(durability) };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
}
