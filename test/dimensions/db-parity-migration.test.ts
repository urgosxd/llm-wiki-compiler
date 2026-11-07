/**
 * @file test/dimensions/db-parity-migration.test.ts
 * @description Prove, against a real Postgres, that
 * `src/dimensions/wiki/migration_wiki_db_parity.sql` upgrades an existing database into
 * exactly the shape a FRESH install reaches from the mirrored `schema.sql`.
 *
 * ## The failure this test is built to catch
 *
 * The migration and its mirror are two copies of the same DDL -- this package has no
 * migration runner, so `schema.sql` must be self-sufficient for a clean install while a
 * live database still needs the migration applied by hand (the convention recorded in
 * `migration_page_embeddings.sql`, and in `migration_open_kg_classification.sql` in the
 * KG package). Two copies drift. When they do, every operator who migrates gets a
 * database that differs from every database created after the change, and the symptom
 * appears months later as "works on a new stack, not on production" -- the hardest class
 * of bug to attribute. So the two copies are compared by a database, not by a reviewer.
 *
 * ## How the pre-migration database is obtained without a third copy
 *
 * `schema.sql` delimits the mirrored region with `wiki-db-parity-mirror:begin` and
 * `wiki-db-parity-mirror:end`. Database A is built by applying every file
 * `scripts/apply-schemas.sh` lists, in that script's order, with the migration EXCLUDED
 * and those delimited regions STRIPPED from the wiki schema. That is a genuine
 * pre-migration database: it has no `aliases` column, no `attribution_gaps` column and
 * none of the three new tables. Database B is A plus the migration file. Database C is
 * the mirror, unlmodified. B must equal C.
 *
 * The order of files is PARSED from `scripts/apply-schemas.sh`, exactly as
 * `packages/llmwiki-kg/ts/src/testing/per-run-database.ts` does, so this suite cannot
 * disagree with the runner about what a complete database is. That helper is not
 * reused directly because it applies the WHOLE list to one database; this suite needs
 * three databases built from three different file subsets.
 *
 * ## Why the comparison is structural
 *
 * Not a diff of file text, which would fail on comments and pass on a changed type.
 * {@link snapshot} reads `pg_attribute` / `pg_indexes` / `pg_constraint` / `pg_class` /
 * `pg_policies` and normalises each row into one sorted line, so a divergence names
 * itself: `wiki.category_members | stack_id | uuid | not null | default -` missing from
 * one side, or an index the mirror forgot. Every dimension is compared, including the
 * row-level-security flags and the tenant policies, because a table that is granted and
 * not isolated is the one silent failure this schema exists to prevent.
 *
 * ## It must never skip
 *
 * A database-backed suite that skips asserts nothing and is reported as a pass (see
 * `packages/llmwiki-kg/ts/src/testing/no-database.ts`). Nothing here catches an
 * unreachable server: `beforeAll` throws, the file fails, and the message carries the
 * connection error.
 *
 * ## What it does NOT cover
 *
 * Column ORDER is not compared (lines are sorted), and neither are grants or sequence
 * state: a mirror that names the same columns in a different order is equivalent here,
 * and `grant ... to llmwiki_app` is checked by `scripts/apply-schemas.sh --check`
 * instead. This suite owns structure and data survival.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import type { Sql } from "postgres";

import { isPerRunDatabaseName, PER_RUN_DATABASE_PREFIX } from "../fixtures/per-run-database.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

/** Repository root, from this file, so the caller's cwd cannot matter. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The migration under test. */
const MIGRATION = "src/dimensions/wiki/migration_wiki_db_parity.sql";

/** The wiki schema of record, which carries the mirror. */
const WIKI_SCHEMA = "src/dimensions/wiki/schema.sql";

/** Delimiters of a mirrored region in {@link WIKI_SCHEMA}. */
const MARKER_BEGIN = "wiki-db-parity-mirror:begin";
const MARKER_END = "wiki-db-parity-mirror:end";

/** Tables the migration is supposed to create, and nothing else. */
const PARITY_TABLES = ["wiki.categories", "wiki.category_members", "wiki.curated_links"];

/** Columns the migration is supposed to add to a table that already existed. */
const PARITY_PAGE_COLUMNS = ["wiki.pages.aliases", "wiki.pages.attribution_gaps"];

/** The dimensions a schema snapshot compares, in reporting order. */
const DIMENSIONS = ["tables", "columns", "indexes", "constraints", "rls", "policies"] as const;

type Dimension = (typeof DIMENSIONS)[number];

/** One database's whole structure, as sorted normalised lines. */
type SchemaSnapshot = Record<Dimension, string[]>;

/** A database this suite created and is allowed to drop. */
interface Scratch {
  readonly name: string;
  readonly url: string;
}

/** Every scratch database this process created, so teardown can drop exactly those. */
const created: Scratch[] = [];

/** Open a single-connection client with server NOTICEs silenced. */
function openClient(url: string): Sql {
  return postgres(url, { max: 1, onnotice: () => undefined });
}

/** The `postgres` database on the same server: `create database` cannot run from inside it. */
function adminUrl(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

/**
 * Create an empty per-run database on `base`'s server.
 *
 * The name follows the harness's own convention, so a database left behind by a killed
 * process is reaped by `reapStalePerRunDatabases` instead of leaking forever, and so
 * {@link dropScratch} can refuse anything this convention did not mint.
 */
async function createScratch(base: string, label: string): Promise<Scratch> {
  const stamp = Date.now().toString(36);
  const name = `${PER_RUN_DATABASE_PREFIX}${stamp}_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = openClient(adminUrl(base));
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 10 });
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  console.log(`db-parity-migration: built database ${name} for ${label}`);
  const scratch: Scratch = { name, url: url.toString() };
  created.push(scratch);
  return scratch;
}

/** Drop one database this suite created, refusing any name it did not mint. */
async function dropScratch(scratch: Scratch): Promise<void> {
  if (!isPerRunDatabaseName(scratch.name)) {
    throw new Error(`refusing to drop "${scratch.name}": not a per-run database name`);
  }
  const admin = openClient(adminUrl(scratch.url));
  try {
    await admin.unsafe(`drop database if exists "${scratch.name}" with (force)`);
  } finally {
    await admin.end({ timeout: 10 });
  }
}

/** Open a client against `scratch`, run `work`, always close it. */
async function withDb<T>(scratch: Scratch, work: (client: Sql) => Promise<T>): Promise<T> {
  const client = openClient(scratch.url);
  try {
    return await work(client);
  } finally {
    await client.end({ timeout: 10 });
  }
}

/**
 * The schema files a complete database needs, in the runner's order.
 *
 * Parsed rather than copied: a second list would drift from
 * `scripts/apply-schemas.sh`, and the drift would show up as a suite failing on a table
 * nobody remembered to add.
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
  if (!listed.includes(MIGRATION)) {
    throw new Error(
      `scripts/apply-schemas.sh does not list ${MIGRATION}, so no database it builds ` +
        "would ever receive this migration and there is nothing to prove",
    );
  }
  return listed;
}

/**
 * Remove every `wiki-db-parity-mirror` region from a SQL file.
 *
 * Reconstructs the PRE-mirror text, which is what a database built before this change
 * looked like. The markers must be on their own lines and the delimited region must be a
 * whole statement or a whole column list, so the remainder still parses; if the markers
 * are missing this throws rather than quietly returning the mirrored text, because that
 * would make the whole suite compare a database against itself.
 */
function stripMirrorRegions(sql: string): string {
  const lines = sql.split("\n");
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.includes(MARKER_BEGIN)) {
      inside = true;
      continue;
    }
    if (line.includes(MARKER_END)) {
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }
  if (kept.length === lines.length) {
    throw new Error(`${WIKI_SCHEMA} carries no ${MARKER_BEGIN} region to strip`);
  }
  return kept.join("\n");
}

/** Apply one SQL file to `client`, stripped when it is the wiki schema of record. */
async function applyOne(client: Sql, file: string, strip: boolean): Promise<void> {
  const body = await readFile(path.join(REPO_ROOT, file), "utf-8");
  await client.unsafe(strip && file === WIKI_SCHEMA ? stripMirrorRegions(body) : body);
}

/** Apply a file list in order, optionally stripping the mirror from the wiki schema. */
async function applyFiles(client: Sql, files: readonly string[], strip: boolean): Promise<void> {
  for (const file of files) {
    await applyOne(client, file, strip);
  }
}

/** One catalogue row, before normalisation. */
interface ColumnRow {
  tbl: string;
  col: string;
  type: string;
  is_not_null: boolean;
  def: string | null;
}

/** `table.column | type | nullability | default`, the line compared for a column. */
function columnLine(row: ColumnRow): string {
  const nullability = row.is_not_null ? "not null" : "nullable";
  return `${row.tbl}.${row.col} | ${row.type} | ${nullability} | default ${row.def ?? "-"}`;
}

/** Every user column of every `public` and `wiki` table, as normalised lines. */
async function columnLines(client: Sql): Promise<ColumnRow[]> {
  return client<ColumnRow[]>`
    select n.nspname || '.' || c.relname as tbl,
           a.attname as col,
           format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as is_not_null,
           pg_get_expr(d.adbin, d.adrelid) as def
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname in ('public', 'wiki')
      and c.relkind = 'r'
      and a.attnum > 0
      and not a.attisdropped
  `;
}

/** Every index, as `schema.table.indexname | definition`. */
async function indexLines(client: Sql): Promise<string[]> {
  const rows = await client<{ name: string; def: string }[]>`
    select schemaname || '.' || tablename || '.' || indexname as name, indexdef as def
    from pg_indexes
    where schemaname in ('public', 'wiki')
  `;
  return rows.map((row) => `${row.name} | ${row.def}`);
}

/** Every constraint, as `schema.table.constraint | definition`. */
async function constraintLines(client: Sql): Promise<string[]> {
  const rows = await client<{ name: string; def: string }[]>`
    select n.nspname || '.' || c.relname || '.' || co.conname as name,
           pg_get_constraintdef(co.oid) as def
    from pg_constraint co
    join pg_class c on c.oid = co.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'wiki')
  `;
  return rows.map((row) => `${row.name} | ${row.def}`);
}

/** Every table's row-level-security flags, as `schema.table | rls=… force=…`. */
async function rlsLines(client: Sql): Promise<string[]> {
  const rows = await client<{ tbl: string; rls: boolean; forced: boolean }[]>`
    select n.nspname || '.' || c.relname as tbl,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'wiki') and c.relkind = 'r'
  `;
  return rows.map((row) => `${row.tbl} | rls=${row.rls} force=${row.forced}`);
}

/** Every tenant policy, as `schema.table.policy | cmd | roles | using | check`. */
async function policyLines(client: Sql): Promise<string[]> {
  const rows = await client<
    { tbl: string; name: string; cmd: string; roles: string; qual: string; check: string }[]
  >`
    select schemaname || '.' || tablename as tbl,
           policyname as name,
           cmd,
           roles::text as roles,
           coalesce(qual, '') as qual,
           coalesce(with_check, '') as check
    from pg_policies
    where schemaname in ('public', 'wiki')
  `;
  return rows.map(
    (row) => `${row.tbl}.${row.name} | ${row.cmd} | ${row.roles} | ${row.qual} | ${row.check}`,
  );
}

/** One database's whole structure, every dimension sorted so two snapshots compare directly. */
async function snapshot(client: Sql): Promise<SchemaSnapshot> {
  const columns = await columnLines(client);
  return {
    tables: [...new Set(columns.map((row) => row.tbl))].sort(),
    columns: columns.map(columnLine).sort(),
    indexes: (await indexLines(client)).sort(),
    constraints: (await constraintLines(client)).sort(),
    rls: (await rlsLines(client)).sort(),
    policies: (await policyLines(client)).sort(),
  };
}

/** Items of `left` that `right` does not contain. */
function onlyIn(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return left.filter((line) => !other.has(line));
}

/** Assert two databases agree on every dimension, naming each divergence. */
function expectSameSchema(left: SchemaSnapshot, right: SchemaSnapshot, label: string): void {
  for (const dimension of DIMENSIONS) {
    const extra = onlyIn(left[dimension], right[dimension]);
    const missing = onlyIn(right[dimension], left[dimension]);
    expect({ label, dimension, extra, missing }).toEqual({
      label,
      dimension,
      extra: [],
      missing: [],
    });
  }
}

/** The table a column line names (`schema.table` out of `schema.table.column | …`). */
function tableOfColumnLine(line: string): string {
  const name = columnNameOfLine(line);
  return name.slice(0, name.lastIndexOf("."));
}

/** The `table.column` a column line names. */
function columnNameOfLine(line: string): string {
  return line.split(" | ")[0] ?? "";
}

/** The tenant predicate every `public` and `wiki` policy must read, as Postgres deparses it. */
const TENANT_PREDICATE = "NULLIF(current_setting('app.stack_id'::text, true), ''::text)";

const stackId = randomUUID();
let preMigrationDb: Scratch;
let freshInstallDb: Scratch;
let before: SchemaSnapshot;
let after: SchemaSnapshot;
let afterSecondApply: SchemaSnapshot;
let fresh: SchemaSnapshot;
let freshAfterMigration: SchemaSnapshot;

/** Apply the migration to the pre-migration database, twice, snapshotting around it. */
async function migrateInPlace(client: Sql): Promise<void> {
  before = await snapshot(client);
  await applyOne(client, MIGRATION, false);
  after = await snapshot(client);
  await applyOne(client, MIGRATION, false);
  afterSecondApply = await snapshot(client);
}

/** Seed one Stack and one page row BEFORE the migration, so survival is observable. */
async function seedPageRow(client: Sql): Promise<void> {
  await client`select set_config('app.stack_id', ${stackId}, false)`;
  await client`insert into public.stacks (id, name, domain)
    values (${stackId}, 'db-parity-migration', 'db-parity-migration')`;
  await client`insert into wiki.pages (stack_id, page_directory, slug, title)
    values (${stackId}, 'concepts', 'alpha-topic', 'Alpha Topic')`;
}

beforeAll(async () => {
  const base = testDatabaseUrl();
  const files = await schemaFiles();
  preMigrationDb = await createScratch(base, "pre-migration");
  freshInstallDb = await createScratch(base, "fresh-install");
  await withDb(preMigrationDb, async (client) => {
    await applyFiles(client, files.filter((file) => file !== MIGRATION), true);
    await seedPageRow(client);
    await migrateInPlace(client);
  });
  await withDb(freshInstallDb, async (client) => {
    await applyFiles(client, files.filter((file) => file !== MIGRATION), false);
    fresh = await snapshot(client);
    await applyOne(client, MIGRATION, false);
    freshAfterMigration = await snapshot(client);
  });
}, 180_000);

afterAll(async () => {
  // Only the databases this process created, and only names this suite minted: a failed
  // `beforeAll` leaves `created` short and teardown still never reaches another suite's
  // database. Nothing here is dropped by pattern.
  for (const scratch of created) {
    await dropScratch(scratch);
  }
}, 60_000);

describe("wiki DB parity migration", () => {
  it("migrates a pre-migration database into the shape a fresh install reaches", () => {
    expectSameSchema(after, fresh, "migrated (A + migration) vs fresh install (mirror)");
  });

  it("is idempotent: a second apply changes nothing and the fresh install needs it not", () => {
    expectSameSchema(afterSecondApply, after, "second apply on the migrated database");
    expectSameSchema(freshAfterMigration, fresh, "migration applied on top of the mirror");
  });

  it("adds exactly the intended objects and removes nothing", () => {
    expect(onlyIn(before.tables, after.tables)).toEqual([]);
    expect(onlyIn(after.tables, before.tables)).toEqual(PARITY_TABLES);
    const addedColumns = onlyIn(after.columns, before.columns);
    const onNewTables = addedColumns.filter((line) =>
      PARITY_TABLES.includes(tableOfColumnLine(line)),
    );
    expect(onNewTables.length).toBeGreaterThan(0);
    const onExistingTables = addedColumns.filter((line) => !onNewTables.includes(line));
    expect(onExistingTables.map(columnNameOfLine).sort()).toEqual(PARITY_PAGE_COLUMNS);
    for (const dimension of DIMENSIONS) {
      expect({ dimension, removed: onlyIn(before[dimension], after[dimension]) }).toEqual({
        dimension,
        removed: [],
      });
    }
  });

  it("keeps an existing page row and defaults the new columns to an empty array", async () => {
    const rows = await withDb(preMigrationDb, (client) =>
      client<{ title: string; aliases: unknown; gaps: unknown }[]>`
        select title, aliases, attribution_gaps as gaps
        from wiki.pages
        where stack_id = ${stackId}
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Alpha Topic");
    expect(rows[0]?.aliases).toEqual([]);
    expect(rows[0]?.gaps).toEqual([]);
  });

  it("tenant-isolates the new tables exactly as their siblings are", () => {
    for (const table of PARITY_TABLES) {
      expect(after.rls).toContain(`${table} | rls=true force=true`);
      expect(after.policies.some((line) => line.startsWith(`${table}.tenant_isolation |`))).toBe(
        true,
      );
    }
    expect(after.policies.every((line) => line.includes(TENANT_PREDICATE))).toBe(true);
    expect(after.tables).toContain("wiki.concept_aliases");
  });
});
