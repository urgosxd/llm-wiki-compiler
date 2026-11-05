/**
 * @file packages/llmwiki-kg/ts/src/testing/per-run-database.ts
 * @description Give every Postgres-touching test PROCESS its own database.
 *
 * ## Why this lives inside the package and not in `test/fixtures/`
 *
 * `tsconfig.json` here sets `rootDir: "src"` with an include glob rooted at `src`, so a
 * under `src/` may not import anything above it — TS6059. `db.test.ts` lives in `src/`
 * and has to provision a database of its own, so the implementation has to be reachable
 * from inside `src/`. `test/fixtures/per-run-database.ts` re-exports it with the test
 * resolver bound, and both callers share this one implementation. Moving it back to
 * `test/fixtures/` re-breaks `npm run typecheck:kg`; the gate is why it is here.
 *
 * ## The class this closes
 *
 * `src/db.test.ts:413` failed intermittently under parallel load with
 * `expected +0 to be 1` and was green 15/15 isolated. No assertion was flaky: the
 * suite's `afterAll` ran `delete from stacks where domain like 't04-route-%'` against
 * the ONE database every suite shared, so a parallel worker's rows vanished mid-run and
 * a teardown looked like a disappearing Stack. Deleting-by-pattern is only safe if
 * nobody else's rows can match, and with a shared database nobody can promise that.
 *
 * So isolation moves from "remember to scope your deletes" to "you cannot reach another
 * suite's rows at all": each test file gets a database of its own, created on first use
 * in that process and dropped when the process ends.
 *
 * ## Why a database and not a `search_path`
 *
 * The schema files hardcode `public.` and `wiki.` in every statement, so a per-run
 * schema would mean rewriting DDL owned by `scripts/apply-schemas.sh`. A database is the
 * unit that file set already targets: it creates the `llmwiki_app` grants and the
 * per-database policies the RLS suites read back.
 *
 * ## Why the schema comes from the script, not from a copy of its list
 *
 * `scripts/apply-schemas.sh` is the source of truth for which 15 files a complete
 * database needs, in which order. A second copy here would drift and the drift would
 * show up as a suite failing on a table nobody remembered to add. The list is PARSED
 * from that script instead.
 *
 * ## Why per PROCESS and not per test
 *
 * Measured: vitest runs each test FILE in its own process, so a process-scoped database
 * is a file-scoped database. Creating one costs ~0.2s (recorded in
 * `odd/tasks/reach-test.md`), which is affordable once per file and not affordable once
 * per test.
 *
 * ## Leftover databases
 *
 * A killed process cannot run its teardown, so every name carries a run token and
 * {@link createSuiteDatabase} reaps databases older than {@link STALE_AFTER_MS} before
 * creating its own. Reaping is age-based on purpose: dropping every sibling database on
 * sight would delete a LIVE parallel worker's database, which is the same class of bug
 * as the one being fixed.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import type { Sql } from "postgres";

/** Every per-run database name starts with this, so debris is identifiable. */
export const PER_RUN_DATABASE_PREFIX = "llmwiki_suite_";

/** A database older than this is debris from a process that never tore down. */
const STALE_AFTER_MS = 30 * 60_000;

/** Repository root, resolved from this file so the caller's cwd cannot matter. */
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

/** Tables a complete database must expose; the replay is verified against them. */
const REQUIRED_TABLES = [
  "public.stacks",
  "public.stack_documents",
  "public.document_chunks",
  "public.ontology_entities",
  "public.ontology_relationships",
  "public.entity_source_documents",
  "public.entity_pages",
  "wiki.pages",
  "wiki.source_documents",
];

/** One caller's private database. */
export interface SuiteDatabase {
  /** Human-facing label, used only to make a failure readable. */
  readonly label: string;
  /** Database name, unique to this caller and this run. */
  readonly name: string;
  /** Connection string pointing AT {@link name}. */
  readonly url: string;
  /** Drop the database. Best effort, idempotent, safe to call twice. */
  drop(): Promise<void>;
}

/** Names this process has already dropped, so teardown cannot drop them twice. */
const dropped = new Set<string>();

/**
 * The administrative connection: same server and credentials, `postgres` database.
 *
 * `CREATE DATABASE` cannot run inside a transaction and cannot run from a connection to
 * the database being created, so the fixture always goes through this URL.
 *
 * @param base - Any connection string on the target server.
 * @returns The same string retargeted at the always-present `postgres` database.
 */
function adminUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

/** The connection string for `name` on the server `base` points at. */
function urlFor(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Is `name` one this module created? */
export function isPerRunDatabaseName(name: string): boolean {
  return /^llmwiki_suite_[0-9a-z]+_[0-9]+_[0-9a-f]+$/.test(name);
}

/**
 * A fresh, unique, debris-identifiable database name.
 *
 * The token is a base-36 millisecond stamp so reaping can tell age from the name alone,
 * plus the pid and random bytes so two processes starting in the same millisecond never
 * collide.
 */
function freshName(): string {
  const stamp = Date.now().toString(36);
  const random = randomBytes(4).toString("hex");
  return `${PER_RUN_DATABASE_PREFIX}${stamp}_${process.pid}_${random}`;
}

/** When the database `name` was created, or `undefined` if it is not ours. */
function createdFromName(name: string): number | undefined {
  if (!isPerRunDatabaseName(name)) return undefined;
  const stamp = name.slice(PER_RUN_DATABASE_PREFIX.length).split("_")[0] ?? "";
  const parsed = Number.parseInt(stamp, 36);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A single-connection client with server NOTICEs silenced.
 *
 * The schema files are idempotent BY DESIGN (`create ... if not exists`,
 * `drop policy if exists`), so replaying fifteen of them emits dozens of "already
 * exists, skipping" notices. postgres-js prints notices through `console.log` and its
 * handler is fixed when the client is built, so this client is built here rather than
 * through `createClient`: emitting that much noise into every suite's output would bury
 * the failures the output exists for.
 */
function openClient(url: string): Sql {
  return postgres(url, { max: 1, onnotice: () => undefined });
}

/** Open a client against `url`, run `work`, always close it. */
async function withClient<T>(url: string, work: (client: Sql) => Promise<T>): Promise<T> {
  const client = openClient(url);
  try {
    return await work(client);
  } finally {
    await client.end({ timeout: 10 });
  }
}

/** Drop one database, refusing to touch a name this module did not mint. */
async function dropDatabase(base: string, name: string): Promise<void> {
  if (!isPerRunDatabaseName(name)) {
    throw new Error(`refusing to drop "${name}": not a per-run database name`);
  }
  await withClient(adminUrlFor(base), (client) =>
    client.unsafe(`drop database if exists "${name}" with (force)`),
  );
  dropped.add(name);
}

/** Every per-run database currently on the server `base` points at, debris included. */
export async function listPerRunDatabases(base: string): Promise<string[]> {
  return withClient(adminUrlFor(base), async (client) => {
    const rows = await client<{ datname: string }[]>`
      select datname from pg_database where datname like ${`${PER_RUN_DATABASE_PREFIX}%`}
      order by datname
    `;
    return rows.map((row) => row.datname);
  });
}

/**
 * Drop every per-run database older than {@link STALE_AFTER_MS}.
 *
 * @param base - Connection string identifying the server.
 * @param now - Clock override, so the rule is testable without waiting.
 * @returns The names that were reaped.
 */
export async function reapStalePerRunDatabases(
  base: string,
  now: number = Date.now(),
): Promise<string[]> {
  const stale = (await listPerRunDatabases(base)).filter((name) => {
    const created = createdFromName(name);
    return created !== undefined && now - created > STALE_AFTER_MS;
  });
  for (const name of stale) await dropDatabase(base, name);
  return stale;
}

/**
 * The schema files a complete database needs, parsed from the script that owns them.
 *
 * @returns Repository-relative paths, in the order the script applies them.
 */
async function schemaFiles(): Promise<string[]> {
  const script = await readFile(path.join(REPO_ROOT, "scripts/apply-schemas.sh"), "utf-8");
  const start = script.indexOf("SCHEMA_FILES=(");
  const end = start === -1 ? -1 : script.indexOf("\n)", start);
  if (start === -1 || end === -1) {
    throw new Error("scripts/apply-schemas.sh no longer declares a SCHEMA_FILES array");
  }
  const listed = script
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""))
    .filter((entry) => entry !== "");
  if (listed.length === 0) {
    throw new Error("scripts/apply-schemas.sh declares SCHEMA_FILES but lists no file");
  }
  return listed;
}

/**
 * Split a SQL file into statements, honouring comments, strings and `$tag$` bodies.
 *
 * Only used for a file the server refuses to parse as one string: the whole-file path is
 * one round trip and is tried first.
 */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const commentEnd = char === "-" && text[index + 1] === "-" ? endOfLine(text, index) : -1;
    if (commentEnd !== -1) {
      current += text.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }
    if (char === "'" || char === "$") {
      const stop = endOfLiteral(text, index);
      if (stop === index) {
        current += char;
        index += 1;
        continue;
      }
      current += text.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === ";") {
      out.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out.filter((statement) => statement.replace(/--.*$/gm, "").trim() !== "");
}

/** Index of the newline ending the line comment that starts at `start`. */
function endOfLine(text: string, start: number): number {
  const found = text.indexOf("\n", start);
  return found === -1 ? text.length : found;
}

/**
 * Index just past the quoted literal or `$tag$` body starting at `start`.
 *
 * A `$` that does not open a `$tag$` body is an ordinary character, so the caller gets
 * `start` back and copies one character.
 */
function endOfLiteral(text: string, start: number): number {
  if (text[start] === "$") {
    const tag = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(start))?.[0];
    if (tag === undefined) return start;
    const close = text.indexOf(tag, start + tag.length);
    return close === -1 ? text.length : close + tag.length;
  }
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "'" && text[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (text[index] === "'") return index + 1;
    index += 1;
  }
  return text.length;
}

/**
 * Apply every statement of one file, collecting the ones the server refused.
 *
 * @returns One line per failed statement: its first code line and the error.
 */
async function applyStatements(client: Sql, statements: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const statement of statements) {
    try {
      await client.unsafe(statement);
    } catch (error) {
      const first = statement.split("\n").find((line) => !line.trim().startsWith("--")) ?? "";
      failed.push(`${first.trim()} => ${(error as Error).message}`);
    }
  }
  return failed;
}

/**
 * Apply one schema file, falling back to statement granularity when it will not parse.
 *
 * The fallback exists because `migration_wiki_graph.sql` carries a stray `);` that makes
 * the whole file unparseable; every other statement in it is valid and needed. Failures
 * are RETURNED, never swallowed: {@link applySchema} reports them and
 * {@link assertRequiredTables} decides whether the result is usable.
 */
async function applyFile(client: Sql, relative: string): Promise<string[]> {
  const body = await readFile(path.join(REPO_ROOT, relative), "utf-8");
  try {
    await client.unsafe(body);
    return [];
  } catch {
    return applyStatements(client, splitStatements(body));
  }
}

/**
 * Build the schema in a fresh database and verify the result.
 *
 * @param client - Connection to the new database, as the superuser role.
 */
async function applySchema(client: Sql): Promise<void> {
  for (const relative of await schemaFiles()) {
    const failed = await applyFile(client, relative);
    if (failed.length > 0) {
      console.warn(
        `per-run database: ${relative} could not be replayed as one statement; ` +
          `${failed.length} statement(s) failed:\n  ${failed.join("\n  ")}`,
      );
    }
  }
  await assertRequiredTables(client);
}

/**
 * Fail loudly if the replay did not produce the tables the suites cannot run without.
 *
 * @param client - Connection to the database that was just built.
 */
async function assertRequiredTables(client: Sql): Promise<void> {
  const rows = await client<{ name: string }[]>`
    select table_schema || '.' || table_name as name
    from information_schema.tables where table_schema in ('public', 'wiki')
  `;
  const present = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(`per-run database is missing ${missing.join(", ")}`);
  }
}

/** Program the process-exit teardown runs: drop this process's database. */
const DROP_SCRIPT = [
  'import postgres from "postgres";',
  'const url = process.env.PER_RUN_ADMIN_URL ?? "";',
  'const name = process.env.PER_RUN_DATABASE_NAME ?? "";',
  "const sql = postgres(url, { max: 1, onnotice: () => {} });",
  'try { await sql.unsafe(`drop database if exists "${name}" with (force)`); } catch {}',
  "await sql.end({ timeout: 5 }).catch(() => {});",
].join("\n");

/**
 * Drop this process's database after the process is done with it.
 *
 * An `exit` handler cannot await, and the driver has no synchronous mode, so the drop
 * runs in a synchronous child process instead.
 *
 * ## Why signals and not only `exit`
 *
 * MEASURED: with only the `exit` handler, every vitest suite file leaked its database.
 * A test worker is torn down with a signal, and Node does NOT emit `exit` for a process
 * that dies from one, so the handler never ran. The plain-node callers cleaned up
 * perfectly (34 databases -> 32), which is what made the difference visible. SIGTERM and
 * SIGINT therefore drop first and then exit as they otherwise would have.
 *
 * Still best effort: a SIGKILLed process runs nothing, and such a database is reaped by
 * {@link reapStalePerRunDatabases} on a later run.
 */
function dropOnExit(base: string, name: string): void {
  const drop = (): void => {
    if (dropped.has(name)) return;
    spawnSync(process.execPath, ["--input-type=module", "-e", DROP_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      timeout: 30_000,
      env: { ...process.env, PER_RUN_ADMIN_URL: adminUrlFor(base), PER_RUN_DATABASE_NAME: name },
    });
  };
  process.once("exit", drop);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      drop();
      process.exit(0);
    });
  }
}

/**
 * Create a database on the server `base` points at, build the schema in it, hand it back.
 *
 * @param base - Connection string identifying the server to provision on.
 * @param label - Short label, for debuggability and error text.
 * @returns The suite database; `drop()` when the caller is finished with it.
 */
export async function createSuiteDatabase(base: string, label: string): Promise<SuiteDatabase> {
  await reapStalePerRunDatabases(base).catch(() => undefined);
  const name = freshName();
  await withClient(adminUrlFor(base), (client) => client.unsafe(`create database "${name}"`));
  const url = urlFor(base, name);
  try {
    await withClient(url, (client) => applySchema(client));
  } catch (error) {
    await dropDatabase(base, name).catch(() => undefined);
    throw new Error(`could not provision the suite database for ${label}: ${(error as Error).message}`);
  }
  return {
    label,
    name,
    url,
    drop: () => dropDatabase(base, name).catch(() => undefined),
  };
}

/** One database per server per process, so repeated calls are free. */
const ownSuites = new Map<string, Promise<SuiteDatabase>>();

/**
 * This process's database on `base`, created on first call.
 *
 * Memoised per base URL: a process that provisions on one server gets one database, and
 * a test that points at another server gets its own.
 *
 * @param base - Connection string identifying the server to provision on.
 * @returns The suite database for this process.
 */
export function perRunDatabase(base: string): Promise<SuiteDatabase> {
  const existing = ownSuites.get(base);
  if (existing !== undefined) return existing;
  const created = createSuiteDatabase(base, `process-${process.pid}`).then((suite) => {
    dropOnExit(base, suite.name);
    return suite;
  });
  ownSuites.set(base, created);
  return created;
}
