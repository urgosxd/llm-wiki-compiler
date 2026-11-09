/**
 * @file test/fixtures/rls-catalog.ts
 * @description The ONE derivation of "which relations carry a tenant", plus the SQL needed to
 * address one, shared by the two suites that assert row-level security.
 *
 * ## Why the derivation asks about COLUMN PRESENCE and never about enforcement
 *
 * This replaces a derivation that filtered `pg_class` on
 * `relrowsecurity AND relforcerowsecurity`, and that filter was MEASURED to defeat the point:
 * dropping `force row level security` on `wiki.pages` did not fail the suite, it removed the
 * relation from the derived set (29 -> 28), every loop iterated one table fewer, and the
 * non-empty guard still passed. A suite that reports coverage by shrinking its own scope is a
 * `skipIf` that never runs.
 *
 * So the population comes from the one fact a broken DDL cannot hide — a live `stack_id`
 * column — and the enforcement flags travel WITH each row. A caller therefore FAILS on the
 * relation that lost a flag, naming it, instead of quietly losing it from scope.
 *
 * `pg_policies` is LEFT JOINed for the same reason one level down: an inner join would drop a
 * relation whose policies were deleted entirely, which is a louder break than the one these
 * suites exist to catch. Such a relation arrives with an empty command list and fails coverage.
 *
 * ## Why `public.stacks` is not in this population
 *
 * Its tenant IS its primary key, and its policy matches `id = app.stack_id` OR
 * `domain = app.stack_domain`, so it has no `stack_id` column and no derivation can reach it.
 * `public.stacks` is asserted by its own explicit cases in `kg-rls-write-refusal.test.ts`.
 *
 * ## What a write needs from a policy set
 *
 * BOTH `INSERT` and `UPDATE` covered, satisfied by one `FOR ALL` policy alone or by an `INSERT`
 * policy and an `UPDATE` policy together. Splitting one `FOR ALL` policy is equally strong and
 * must not fail; `SELECT` plus `INSERT` leaves every update ungoverned and must.
 */

import { sql, type SQL } from "drizzle-orm";

/** The column that keys a relation to a tenant. `public.stacks` is the documented exception. */
const STACK_ID_COLUMN = "stack_id";

/** The one policy command that governs reads and writes together. */
const ALL_POLICY_COMMAND = "ALL";

/** The commands a relation's policy set must BOTH cover for a tenant write to be refused. */
const WRITE_POLICY_COMMANDS: readonly string[] = ["INSERT", "UPDATE"];

/** A NOT NULL column an INSERT must supply because it has no default. */
export interface RequiredColumn {
  readonly name: string;
  readonly type: string;
  readonly enumLabel: string | null;
  readonly isArray: boolean;
}

/** A relation whose tenant isolation a suite asserts. */
export interface TenantRelation {
  /** Schema-qualified name; used as SQL and quoted in every failure message. */
  readonly identifier: string;
  /** The column carrying the tenant: `stack_id` everywhere in this population. */
  readonly tenantColumn: string;
  /** Columns a generated INSERT must supply. */
  readonly requiredColumns: readonly RequiredColumn[];
}

/** A catalog-derived relation plus the enforcement flags and policy commands measured on it. */
export interface DerivedRelation extends TenantRelation {
  /** `pg_class.relrowsecurity`: row-level security is turned on for the table. */
  readonly rowSecurityEnabled: boolean;
  /** `pg_class.relforcerowsecurity`: the policies also bind the table OWNER. */
  readonly rowSecurityForced: boolean;
  /** Distinct `pg_policies.cmd` values measured on the relation; empty when it has no policy. */
  readonly commands: readonly string[];
}

/** Runs one query and returns its rows; the harness's own executor satisfies this. */
export type CatalogExecutor = <R>(query: SQL) => Promise<R[]>;

/**
 * Every `stack_id`-keyed relation, with its two RLS flags and its policy commands.
 *
 * The `where` clause asks for COLUMN PRESENCE ONLY: no enforcement flag filters the set, so a
 * relation that lost one is REPORTED with `rowSecurityEnabled`/`rowSecurityForced` false and
 * fails the caller's per-relation assertion by name, instead of leaving the set silently.
 *
 * `pg_policies` is LEFT JOINed so a relation with no policy at all is reported with an empty
 * command list rather than dropped from a population it belongs to.
 */
const TENANT_RELATIONS_QUERY = sql`
  select n.nspname || '.' || c.relname as identifier,
         c.relrowsecurity as "rowSecurityEnabled",
         c.relforcerowsecurity as "rowSecurityForced",
         coalesce(array_agg(distinct p.cmd) filter (where p.cmd is not null), array[]::text[])
           as commands
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
  where c.relkind = 'r'
    and n.nspname !~ '^pg_'
    and n.nspname <> 'information_schema'
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'stack_id'
        and a.attnum > 0 and not a.attisdropped
    )
  group by c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
  order by 1
`;

/**
 * Columns a derived relation cannot omit: NOT NULL, no default, not generated.
 *
 * The population must stay IDENTICAL to {@link TENANT_RELATIONS_QUERY}'s — the same `stack_id`
 * presence predicate and no enforcement filter — or a relation derived above arrives with no
 * column list and fails with a message about the catalog instead of about the flag it lost.
 */
const REQUIRED_COLUMNS_QUERY = sql`
  select n.nspname || '.' || c.relname as identifier,
         a.attname as name,
         format_type(a.atttypid, a.atttypmod) as type,
         t.typtype = 'e' as "isEnum",
         (select e.enumlabel from pg_enum e where e.enumtypid = t.oid
           order by e.enumsortorder limit 1) as "enumLabel",
         t.typcategory = 'A' as "isArray"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  join pg_type t on t.oid = a.atttypid
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where c.relkind = 'r'
    and exists (
      select 1 from pg_attribute s
      where s.attrelid = c.oid and s.attname = 'stack_id'
        and s.attnum > 0 and not s.attisdropped
    )
    and a.attnum > 0 and not a.attisdropped
    and a.attnotnull and d.adbin is null
    and a.attgenerated = '' and a.attidentity = ''
  order by 1, a.attnum
`;

/** One required-column row as the catalog returns it. */
interface RequiredColumnRow {
  readonly identifier: string;
  readonly name: string;
  readonly type: string;
  readonly enumLabel: string | null;
  readonly isArray: boolean;
}

/** One derived-relation row as the catalog returns it. */
interface DerivedRelationRow {
  readonly identifier: string;
  readonly rowSecurityEnabled: boolean;
  readonly rowSecurityForced: boolean;
  readonly commands: string[];
}

/** Required columns per relation, grouped from the catalog. */
function groupRequiredColumns(rows: readonly RequiredColumnRow[]): Map<string, RequiredColumn[]> {
  const grouped = new Map<string, RequiredColumn[]>();
  for (const row of rows) {
    const columns = grouped.get(row.identifier) ?? [];
    columns.push({ name: row.name, type: row.type, enumLabel: row.enumLabel, isArray: row.isArray });
    grouped.set(row.identifier, columns);
  }
  return grouped;
}

/**
 * The tenant relations this database has, with their flags, policies and required columns.
 *
 * @param run - Executor for the harness connection; one query per call.
 * @returns The derived population, sorted by identifier.
 * @throws When a derived relation reports no NOT NULL column, because no row could be built.
 */
export async function readTenantRelations(run: CatalogExecutor): Promise<DerivedRelation[]> {
  const required = groupRequiredColumns(await run<RequiredColumnRow>(REQUIRED_COLUMNS_QUERY));
  const rows = await run<DerivedRelationRow>(TENANT_RELATIONS_QUERY);
  return rows.map((row) => {
    const requiredColumns = required.get(row.identifier);
    if (requiredColumns === undefined) {
      throw new Error(
        `the catalog reports ${row.identifier} as keyed by ${STACK_ID_COLUMN} but lists no NOT ` +
          `NULL column on it, so no probe row can be built for it`,
      );
    }
    return {
      identifier: row.identifier,
      tenantColumn: STACK_ID_COLUMN,
      requiredColumns,
      rowSecurityEnabled: row.rowSecurityEnabled,
      rowSecurityForced: row.rowSecurityForced,
      commands: row.commands,
    };
  });
}

/**
 * The write commands a relation's policy set leaves ungoverned.
 *
 * @param commands - Distinct policy commands measured on one relation.
 * @returns The missing commands; empty when the set covers both halves of a write.
 */
export function uncoveredWriteCommands(commands: readonly string[]): readonly string[] {
  if (commands.includes(ALL_POLICY_COMMAND)) return [];
  return WRITE_POLICY_COMMANDS.filter((command) => !commands.includes(command));
}

/** Quote one identifier, doubling embedded quotes. */
function quotedIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote one text literal, doubling embedded quotes. */
function quotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Placeholder values by catalog base type, for required columns with no default. */
const PLACEHOLDERS = new Map<string, string>([
  ["uuid", "gen_random_uuid()"],
  ["text", quotedLiteral("rls-probe")],
  ["character varying", quotedLiteral("rls-probe")],
  ["boolean", "true"],
  ["smallint", "0"],
  ["integer", "0"],
  ["bigint", "0"],
  ["numeric", "0"],
  ["real", "0"],
  ["double precision", "0"],
  ["json", "'{}'::json"],
  ["jsonb", "'{}'::jsonb"],
  ["date", "current_date"],
  ["timestamp with time zone", "now()"],
  ["timestamp without time zone", "now()"],
  ["bytea", "''::bytea"],
]);

/**
 * SQL expression for one required column's placeholder, chosen from its catalog type.
 *
 * @param relation - Identifier the column belongs to, for the failure that names it.
 * @param column - The required column.
 * @returns A literal or function call Postgres accepts for that type.
 * @throws When the type has no placeholder, naming the column so it can be added.
 */
function placeholderFor(relation: string, column: RequiredColumn): string {
  if (column.isArray) return `${quotedLiteral("{}")}::${column.type}`;
  if (column.enumLabel !== null) return `${quotedLiteral(column.enumLabel)}::${column.type}`;
  const vector = /^vector\((\d+)\)$/.exec(column.type);
  if (vector !== null) return `array_fill(0.0::real, ARRAY[${vector[1]}])::vector`;
  const placeholder = PLACEHOLDERS.get(column.type);
  if (placeholder === undefined) {
    throw new Error(
      `${relation}.${column.name} is NOT NULL with no default and has type "${column.type}", ` +
        `which this suite has no placeholder for; add one so the relation stays covered`,
    );
  }
  return placeholder;
}

/**
 * One INSERT supplying every required column, with the tenant column owned by `owner`.
 *
 * The tuple is built from the catalog rather than written per table, which is what lets the
 * loops cover a relation nobody remembered to list.
 *
 * @param relation - Relation to insert into.
 * @param owner - Stack id the new row claims to belong to.
 * @returns The statement, as raw SQL with escaped literals.
 * @throws When the relation has no required tenant column.
 */
export function insertOwnedBy(relation: TenantRelation, owner: string): SQL {
  const ownsTenantColumn = relation.requiredColumns.some(
    (column) => column.name === relation.tenantColumn,
  );
  if (!ownsTenantColumn) {
    throw new Error(
      `${relation.identifier} has no required "${relation.tenantColumn}" column, so this ` +
        `suite cannot place a row in a chosen tenant`,
    );
  }
  const names = relation.requiredColumns.map((column) => quotedIdentifier(column.name));
  const values = relation.requiredColumns.map((column) =>
    column.name === relation.tenantColumn
      ? `${quotedLiteral(owner)}::uuid`
      : placeholderFor(relation.identifier, column),
  );
  return sql.raw(
    `insert into ${relation.identifier} (${names.join(", ")}) values (${values.join(", ")})`,
  );
}
