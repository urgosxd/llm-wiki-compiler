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
 * ## How the pre-migration database is obtained without deriving it from the mirror
 *
 * Database A is built by applying every file `scripts/apply-schemas.sh` lists, in that
 * script's order, with the migration EXCLUDED and the wiki schema of record REPLACED by
 * `test/fixtures/wiki-schema-pre-db-parity.sql`, a frozen copy of `schema.sql` taken
 * before this migration existed. That is a genuine pre-migration database: it has no
 * `aliases` column, no `attribution_gaps` column and none of the three new tables.
 * Database B is A plus the migration file. Database C is a fresh install from the
 * CURRENT `schema.sql`, mirror included. B must equal C.
 *
 * An earlier version of this suite built A by stripping the `wiki-db-parity-mirror`
 * delimited regions out of the current `schema.sql`. That made the actual state and the
 * expected state one file: a drift in the pre-migration portion of `schema.sql` moved
 * BOTH sides of the comparison by the same amount, and the comparison could not see it.
 * The fixture is frozen precisely so that only C follows the schema of record while A
 * stays the database an operator really has. The mirror markers remain in `schema.sql`
 * as documentation; this suite no longer reads them.
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
 * ## What is compared, and what is not
 *
 * Column ORDER is not compared (lines are sorted), nor sequence state: a mirror naming
 * the same columns in a different order is equivalent here. Everything else that
 * "non-destructive" and "reachable by the application" claim IS checked: grants
 * (`has_table_privilege` for `llmwiki_app` on every table this migration touches, in
 * both databases), data survival (a digest of every pre-existing `wiki.pages` column,
 * taken before the first apply and after the second), the absence of `drop table`,
 * `drop column`, `truncate`, `delete from`, `insert into` and `update ... set` in the
 * migration text, and the survival of `wiki.concept_aliases`.
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

/**
 * A frozen copy of {@link WIKI_SCHEMA} from before this migration existed.
 *
 * It must never be regenerated. It stands for the database an operator really has,
 * and it is the only thing keeping the comparison honest once `schema.sql` moves on.
 */
const PRE_MIGRATION_FIXTURE = "test/fixtures/wiki-schema-pre-db-parity.sql";

/** Tables the migration is supposed to create, and nothing else. */
const PARITY_TABLES = ["wiki.categories", "wiki.category_members", "wiki.curated_links"];

/** Columns the migration is supposed to add to a table that already existed. */
const PARITY_PAGE_COLUMNS = ["wiki.pages.aliases", "wiki.pages.attribution_gaps"];

/** The application role every wiki table is granted to by `schema.sql`. */
const APP_ROLE = "llmwiki_app";

/** Tables whose grants this suite compares between the migrated and the fresh database. */
const GRANTED_TABLES = ["wiki.pages", ...PARITY_TABLES];

/** Privileges the application role must hold on each of {@link GRANTED_TABLES}. */
const GRANTED_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/**
 * Statements a non-destructive migration must never contain.
 *
 * Matched against the migration with its `--` comments removed, so the file's own prose
 * about what it does not do cannot trip the scan.
 */
const FORBIDDEN_STATEMENTS: readonly RegExp[] = [
  /\bdrop\s+(table|column)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\binsert\s+into\b/i,
  /\bupdate\s+\w+\s+set\b/i,
];

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

/** Apply one SQL file to `client`, read from the repository so the caller's cwd cannot matter. */
async function applyOne(client: Sql, file: string): Promise<void> {
  const body = await readFile(path.join(REPO_ROOT, file), "utf-8");
  await client.unsafe(body);
}

/** Apply a file list in order. */
async function applyFiles(client: Sql, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await applyOne(client, file);
  }
}

/**
 * The runner's file list with the wiki schema of record swapped for the frozen fixture.
 *
 * Only the fresh install may follow the current `schema.sql`. A database meant to
 * predate the migration has to come from the snapshot, or the comparison proves nothing
 * about a database an operator already has.
 */
function preMigrationFiles(files: readonly string[]): string[] {
  return files.map((file) => (file === WIKI_SCHEMA ? PRE_MIGRATION_FIXTURE : file));
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

/** Strip `--` comments from SQL text, so prose about a statement is not read as one. */
function withoutSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** `table | privilege | granted` for {@link APP_ROLE} on every table the migration touches. */
async function privilegeLines(client: Sql): Promise<string[]> {
  const rows = await client<{ tbl: string; priv: string; granted: boolean }[]>`
    select t.tbl, p.priv, has_table_privilege(${APP_ROLE}, t.tbl, p.priv) as granted
    from unnest(${GRANTED_TABLES}::text[]) as t(tbl)
    cross join unnest(${GRANTED_PRIVILEGES}::text[]) as p(priv)
    order by t.tbl, p.priv
  `;
  return rows.map((row) => `${row.tbl} | ${row.priv} | ${row.granted}`);
}

/**
 * One digest over every value `wiki.pages` held BEFORE this migration, for {@link stackId}.
 *
 * Every column that existed then is included in a stable order and the two columns the
 * migration adds are excluded by name, so an `update` that rewrote an existing value
 * would change this digest even while the schema still matched.
 */
async function preMigrationPageDigest(client: Sql): Promise<string> {
  const rows = await client<{ digest: string | null }[]>`
    select md5(string_agg(line, E'\n' order by line)) as digest
    from (
      select concat_ws('|',
        stack_id::text, page_directory, slug, title, coalesce(source_identity, '<null>'),
        summary, array_to_string(tags, ','), array_to_string(links, ','), body,
        orphaned::text, archived::text,
        extract(epoch from created_at)::text, extract(epoch from updated_at)::text
      ) as line
      from wiki.pages
      where stack_id = ${stackId}
    ) as page_lines
  `;
  return rows[0]?.digest ?? "";
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
let pageDigestBefore: string;
let pageDigestAfterSecond: string;

/** Apply the migration to the pre-migration database, twice, snapshotting around it. */
async function migrateInPlace(client: Sql): Promise<void> {
  before = await snapshot(client);
  pageDigestBefore = await preMigrationPageDigest(client);
  await applyOne(client, MIGRATION);
  after = await snapshot(client);
  await applyOne(client, MIGRATION);
  afterSecondApply = await snapshot(client);
  pageDigestAfterSecond = await preMigrationPageDigest(client);
}

/** Seed one Stack and one fully populated page row BEFORE the migration, so survival shows. */
async function seedPageRow(client: Sql): Promise<void> {
  await client`select set_config('app.stack_id', ${stackId}, false)`;
  await client`insert into public.stacks (id, name, domain)
    values (${stackId}, 'db-parity-migration', 'db-parity-migration')`;
  await client`insert into wiki.pages
      (stack_id, page_directory, slug, title, source_identity, summary, tags, links, body, orphaned)
    values (${stackId}, 'concepts', 'alpha-topic', 'Alpha Topic', 'sources/alpha.md',
      'Seeded before the migration.', array['alpha'], array['concepts/beta'],
      'Seeded body that must survive.', true)`;
}

beforeAll(async () => {
  const base = testDatabaseUrl();
  const files = (await schemaFiles()).filter((file) => file !== MIGRATION);
  preMigrationDb = await createScratch(base, "pre-migration");
  freshInstallDb = await createScratch(base, "fresh-install");
  await withDb(preMigrationDb, async (client) => {
    await applyFiles(client, preMigrationFiles(files));
    await seedPageRow(client);
    await migrateInPlace(client);
  });
  await withDb(freshInstallDb, async (client) => {
    await applyFiles(client, files);
    fresh = await snapshot(client);
    await applyOne(client, MIGRATION);
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

  it("comes from the frozen fixture, not from the mirrored schema of record", () => {
    const preColumns = before.columns.map(columnNameOfLine);
    const freshColumns = fresh.columns.map(columnNameOfLine);
    for (const table of PARITY_TABLES) {
      expect({ table, pre: before.tables.includes(table), fresh: fresh.tables.includes(table) })
        .toEqual({ table, pre: false, fresh: true });
    }
    for (const column of PARITY_PAGE_COLUMNS) {
      expect({ column, pre: preColumns.includes(column), fresh: freshColumns.includes(column) })
        .toEqual({ column, pre: false, fresh: true });
    }
  });

  it("carries no destructive or data-writing statement and leaves concept_aliases alone", async () => {
    const sql = withoutSqlComments(await readFile(path.join(REPO_ROOT, MIGRATION), "utf-8"));
    expect(FORBIDDEN_STATEMENTS.flatMap((pattern) => sql.match(pattern) ?? [])).toEqual([]);
    const rows = await withDb(preMigrationDb, (client) =>
      client<{ found: number }[]>`
        select count(*)::int as found
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'wiki' and c.relname = 'concept_aliases' and c.relkind = 'r'
      `,
    );
    expect(rows[0]?.found).toBe(1);
  });

  it("grants the application role what a fresh install grants it", async () => {
    const migrated = await withDb(preMigrationDb, privilegeLines);
    const installed = await withDb(freshInstallDb, privilegeLines);
    expect(migrated).toHaveLength(GRANTED_TABLES.length * GRANTED_PRIVILEGES.length);
    expect(migrated.filter((line) => line.endsWith("| false"))).toEqual([]);
    expect(migrated).toEqual(installed);
  });

  it("rewrites no value an existing page row already held", () => {
    expect(pageDigestBefore).toMatch(/^[0-9a-f]{32}$/);
    expect(pageDigestAfterSecond).toBe(pageDigestBefore);
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
