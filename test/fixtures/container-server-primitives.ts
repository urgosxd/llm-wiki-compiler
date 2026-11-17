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
 *   fresh Postgres has none and a reused one may have been built by an older image. "Carries" is
 *   not two sentinel tables but the COLUMNS the repository declares: a reused container was
 *   measured serving a gate run while missing two declared columns.
 *
 * ## What is deliberately NOT here
 *
 * No Docker image name, no container lifecycle, no reuse hash, no teardown, no vitest
 * awareness. A caller that owns exactly one container and a caller that shares one can both
 * use these primitives without inheriting the other's ownership rules.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  applySchema,
  withClient,
} from "@repo/kg/testing/per-run-database";

import {
  diffSchema,
  parseDeclaredFile,
  type DeclaredColumn,
  type ParityReport,
  type PresentColumn,
} from "../../scripts/schema-parity-check.js";

/** How long a probe may spend connecting before the server counts as unreachable. */
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 3;

/** Repository root, resolved from this file so the caller's cwd cannot matter. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The runner that owns the one authoritative list of schema files. */
const SCHEMA_RUNNER = "scripts/apply-schemas.sh";

/** How many drifted names one reason may spell out before it summarizes the rest. */
const MAX_NAMED_DRIFT = 6;

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
  /** The durability summary and whether the schema was replayed, or the failure. */
  readonly detail: string;
}

/**
 * The repository-relative SQL files `scripts/apply-schemas.sh` registers, in apply order.
 *
 * PARSED from the runner, never copied: the file list is what "the schema" means, and a second
 * copy of it drifts from the file the runner actually applies.
 */
async function declaredSchemaFiles(): Promise<string[]> {
  const runner = await readFile(path.join(REPO_ROOT, SCHEMA_RUNNER), "utf-8");
  const array = /\bSCHEMA_FILES=\(([\s\S]*?)\n\)/.exec(runner)?.[1] ?? "";
  const files = array
    .split("\n")
    .filter(line => !line.trim().startsWith("#"))
    .flatMap(line => [...line.matchAll(/"([^"]+\.sql)"/g)].map(match => match[1] ?? ""));
  if (files.length === 0) throw new Error(`${SCHEMA_RUNNER} lists no schema file`);
  return files;
}

/**
 * Every column the registered files declare, keyed `schema.table.column`.
 *
 * The declaration parser is `scripts/schema-parity-check.ts`'s — the one the check mode of the
 * runner uses — so this comparison and `CHECK_ONLY=true scripts/apply-schemas.sh` cannot disagree
 * about what the repository declares. A later declaration replaces an earlier one, which is the
 * order the runner applies them in.
 */
async function declaredColumns(): Promise<DeclaredColumn[]> {
  const columns = new Map<string, DeclaredColumn>();
  for (const file of await declaredSchemaFiles()) {
    const sql = await readFile(path.join(REPO_ROOT, file), "utf-8");
    for (const column of parseDeclaredFile(file, sql)) {
      columns.set(`${column.table}.${column.column}`, column);
    }
  }
  return [...columns.values()];
}

/** Every column the database behind `url` reports in the two schemas the declaration covers. */
async function presentColumns(url: string): Promise<PresentColumn[]> {
  const rows = await withClient(url, client =>
    client<{ table: string; column: string }[]>`
      select table_schema || '.' || table_name as "table", column_name as "column"
      from information_schema.columns where table_schema in ('public', 'wiki')
    `,
  );
  return rows.map(row => ({ table: row.table, column: row.column }));
}

/**
 * What the repository declares against what the database behind `url` actually has.
 *
 * @param url - A connection string on the server to compare.
 * @returns The same report `diffSchema` produces for the runner's own check mode.
 */
export async function declaredSchemaDrift(url: string): Promise<ParityReport> {
  return diffSchema(await declaredColumns(), await presentColumns(url));
}

/**
 * Is anything the repository declares ABSENT from the database?
 *
 * Only the missing side counts. A column nothing declares is a warning in the runner's check mode
 * and is one here too: an adopted container carrying a legacy table cannot make a suite pass on
 * state it does not own, which is the failure this gate exists for.
 */
export function hasDrift(report: ParityReport): boolean {
  return report.missingColumns.length > 0 || report.missingTables.length > 0;
}

/** A bounded list of drifted names, so a reason stays one readable line. */
function summarizeDrift(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_DRIFT);
  const rest = names.length - shown.length;
  return rest === 0 ? shown.join(", ") : `${shown.join(", ")} and ${String(rest)} more`;
}

/** The drift as one line: the declared tables, then the declared columns, that are absent. */
function describeDrift(report: ParityReport): string {
  const parts: string[] = [];
  if (report.missingTables.length > 0) {
    parts.push(`missing tables: ${summarizeDrift(report.missingTables)}`);
  }
  if (report.missingColumns.length > 0) {
    const columns = report.missingColumns.map(column => `${column.table}.${column.column}`);
    parts.push(`missing columns: ${summarizeDrift(columns)}`);
  }
  return parts.join("; ");
}

/**
 * Make a container's default database usable, and report what the server says about itself.
 *
 * The schema replay is SKIPPED when the sentinels are already there, so an adopted container
 * costs one cheap query instead of fifteen round trips, and a container started by this run
 * pays the replay exactly once. {@link applySchema} is idempotent either way; the check is
 * what keeps reuse fast.
 *
 * The replay being skipped is exactly why the comparison below exists: "the sentinels are there"
 * says nothing about the columns a later migration added, and a reused container built by an older
 * image was measured serving a whole gate run while missing two declared columns. So the verdict
 * is taken from the declared files against the live catalogue, never from the sentinels: an
 * adopted database that does not match is REFUSED, which is the only way "never adopt blind" can
 * be enforced by the caller that publishes the URL.
 *
 * @param url - The container's default database, as the superuser role.
 * @returns Whether the schema was replayed and the durability summary, or the reason it is unusable.
 */
export async function prepareContainerDatabase(url: string): Promise<PrepareOutcome> {
  try {
    const durability = await durabilityReport(url);
    const replayed = !(await schemaPresent(url));
    if (replayed) await withClient(url, applySchema);
    const drift = await declaredSchemaDrift(url);
    if (hasDrift(drift)) {
      return { ok: false, detail: `does not match the schema this repository declares: ${describeDrift(drift)}` };
    }
    const schema = replayed ? "schema replayed" : "schema matches the declared files, not replayed";
    return { ok: true, detail: `${describeDurability(durability)}; ${schema}` };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
}
