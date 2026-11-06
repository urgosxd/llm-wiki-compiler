/**
 * @file packages/llmwiki-kg/ts/src/schema-open-classification-harness.ts
 * @description Shared fixtures for the open-classification schema suites.
 *
 * ## Why a harness and two test files
 *
 * The migration contract has two halves — what the upgrade does to an existing
 * database, and what the identity/evidence columns allow afterwards — and the
 * repository caps a test file at 400 lines excluding comments. The two halves share
 * the servers, the shape queries and the row fixtures, so those live here instead of
 * being copied into both files.
 *
 * ## The bare database
 *
 * `createSuiteDatabase` applies the FULL, already-migrated schema, so it cannot
 * represent a database that predates this migration. {@link openMigratedLegacyDatabase}
 * therefore mints a database itself, in the per-run name form on purpose: if the
 * process is killed before teardown, the fixture's reaper recognises the name and pid
 * and collects it exactly like its own debris.
 *
 * Row-level security is asserted separately rather than compared, because the bare
 * database has no `migration_rls_tenancy.sql` applied: the tenancy state of the
 * shared tables legitimately differs, while the two tables the migration CREATES must
 * be secured on both paths.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";

import * as schema from "./schema.js";
import { kgClassificationLog, kgEvidence } from "./schema-open-classification.js";
import { PER_RUN_DATABASE_PREFIX, perRunDatabase, withClient } from "./testing/per-run-database.js";

/** The server a suite database is provisioned on: the same host the other suites use. */
export const TEST_SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** This process's database, built from `schema.sql` and the migration list. */
const FRESH = await perRunDatabase(TEST_SERVER_URL);

/** The connection string of this process's fully-migrated database. */
export function freshDatabaseUrl(): string {
  return FRESH.url;
}

/**
 * The same server, retargeted at `database`.
 *
 * `postgres` is always present; anything else has to be created first.
 */
export function serverUrl(database: string): string {
  const url = new URL(TEST_SERVER_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The migration under test, read from the file an operator would run. */
export const MIGRATION_SQL = await readFile(
  new URL("../../db/migration_open_kg_classification.sql", import.meta.url),
  "utf-8",
);

/** The tables this migration touches: the shape both paths must agree on. */
export const TOUCHED_TABLES = [
  "stacks",
  "ontology_entities",
  "ontology_relationships",
  "kg_evidence",
  "kg_classification_log",
] as const;

/** Column names of one `public` table, sorted. */
export async function columnNames(client: Sql, table: string): Promise<string[]> {
  const rows = await client<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by column_name
  `;
  return rows.map((row) => row.column_name);
}

/** Drizzle's database column names for one table, sorted. */
export function drizzleColumnNames(table: PgTable): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name).sort();
}

/**
 * The drizzle tables that must mirror the database, paired by table name.
 *
 * The two open-classification tables are imported from their own module rather than
 * from `schema.ts`, because that module is where they live; `schema.ts` re-exports
 * their TYPES only, to keep the dependency one-way.
 */
export const TABLE_PAIRS: readonly (readonly [string, PgTable])[] = [
  ["stacks", schema.stacks],
  ["ontology_entities", schema.ontologyEntities],
  ["ontology_relationships", schema.ontologyRelationships],
  ["kg_evidence", kgEvidence],
  ["kg_classification_log", kgClassificationLog],
];

/** Everything about one table that the clean-install and upgrade paths must agree on. */
export async function tableShape(client: Sql, table: string): Promise<string> {
  const columns = await client<{ column_name: string; is_nullable: string; data_type: string }[]>`
    select column_name, is_nullable, data_type from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by column_name
  `;
  const constraints = await client<{ conname: string; contype: string }[]>`
    select conname, contype from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = ${table}
    order by conname
  `;
  const indexes = await client<{ indexname: string }[]>`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = ${table}
    order by indexname
  `;
  return JSON.stringify({
    columns: columns.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`),
    constraints: constraints.map((row) => `${row.conname}:${row.contype}`),
    indexes: indexes.map((row) => row.indexname),
  });
}

/** Every touched table's shape, keyed by table name. */
export async function databaseShape(client: Sql): Promise<Record<string, string>> {
  const shape: Record<string, string> = {};
  for (const table of TOUCHED_TABLES) shape[table] = await tableShape(client, table);
  return shape;
}

/**
 * The PRE-migration shape of exactly the tables this migration touches, with real rows.
 *
 * Copied from `db/schema.sql` at the commit before this migration, reduced to the
 * tables it alters or references; `stack_documents` and `document_chunks` carry only a
 * primary key because the migration needs them as foreign-key targets and nothing
 * more. The rows are the point: they carry `verified`, `confidence`, `properties`,
 * `source_kind` and `pipeline` values that the upgrade must not touch, and two
 * case-variant names that must stay two rows.
 */
const LEGACY_SCHEMA_SQL = `
create extension if not exists pgcrypto;

create table stacks (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    domain text not null unique,
    description text,
    scope text not null default 'stack',
    compilation_strategy text default 'incremental',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    synthesize_descriptions boolean not null default false,
    ontology jsonb,
    constraint valid_scope check (scope in ('stack', 'workspace', 'domain')),
    constraint valid_strategy check (compilation_strategy in ('incremental', 'global')),
    constraint valid_domain_slug check (domain ~ '^[a-z0-9-]+$'),
    constraint valid_ontology_is_object check (ontology is null or jsonb_typeof(ontology) = 'object')
);
create index idx_stacks_domain on stacks(domain);

create table stack_documents (id uuid primary key default gen_random_uuid());
create table document_chunks (id uuid primary key default gen_random_uuid());

create table ontology_entities (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,
    name text not null,
    type text not null,
    description text,
    properties jsonb default '{}'::jsonb,
    confidence real not null default 0.5,
    verified boolean not null default false,
    last_seen_at timestamptz not null default now(),
    extracted_at timestamptz not null default now(),
    extracted_by_model text,
    source_kind text default 'document',
    pipeline text default 'llamaindex-schema-extraction',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint unique_name_per_stack unique (stack_id, name)
);
create index idx_entities_stack on ontology_entities(stack_id);
create index idx_entities_type on ontology_entities(type);

create table ontology_relationships (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,
    from_entity_id uuid not null references ontology_entities(id) on delete cascade,
    to_entity_id uuid not null references ontology_entities(id) on delete cascade,
    type text not null,
    description text,
    confidence real not null default 0.5,
    verified boolean not null default false,
    extracted_at timestamptz not null default now(),
    extracted_by_model text,
    source_kind text default 'document',
    pipeline text default 'llamaindex-schema-extraction',
    created_at timestamptz not null default now(),
    constraint unique_edge_per_stack unique (stack_id, from_entity_id, to_entity_id, type)
);
create index idx_rels_stack on ontology_relationships(stack_id);
create index idx_rels_from on ontology_relationships(from_entity_id);
create index idx_rels_to on ontology_relationships(to_entity_id);

insert into stacks (id, name, domain) values
  ('11111111-1111-1111-1111-111111111111', 'Legacy Stack', 'legacy-stack');
insert into ontology_entities
  (id, stack_id, name, type, description, properties, confidence, verified, extracted_by_model,
   source_kind, pipeline)
values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'Gateway', 'SYSTEM', 'Routes traffic', '{"tier": "edge"}'::jsonb, 0.9, true, 'model-a',
   'backfeed', 'human-review'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'gateway', 'SYSTEM', null, '{}'::jsonb, 0.7, false, 'model-b',
   'document', 'llamaindex-schema-extraction');
insert into ontology_relationships
  (id, stack_id, from_entity_id, to_entity_id, type, confidence, verified, source_kind, pipeline)
values
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
   'USES', 0.8, true, 'backfeed', 'human-review');
`;

/** A migrated pre-migration database, plus what it looked like before the upgrade. */
export interface LegacyDatabase {
  /** Connection string of the upgraded database. */
  readonly url: string;
  /** Column names of `ontology_entities` as they were BEFORE the migration ran. */
  readonly entityColumnsBefore: readonly string[];
  /** Drop the database. Best effort, idempotent. */
  drop(): Promise<void>;
}

/**
 * Build a pre-migration database, then apply the migration file to it.
 *
 * @returns The upgraded database and the pre-migration control the suite asserts on.
 */
export async function openMigratedLegacyDatabase(): Promise<LegacyDatabase> {
  const name = `${PER_RUN_DATABASE_PREFIX}${Date.now().toString(36)}_${process.pid}_${randomUUID()
    .replace(/-/g, "")
    .slice(0, 12)}`;
  await withClient(serverUrl("postgres"), (client) =>
    client.unsafe(`create database "${name}"`),
  );
  const url = serverUrl(name);
  let entityColumnsBefore: readonly string[] = [];
  try {
    await withClient(url, async (client) => {
      await client.unsafe(LEGACY_SCHEMA_SQL);
      entityColumnsBefore = await columnNames(client, "ontology_entities");
      await client.unsafe(MIGRATION_SQL);
    });
  } catch (error) {
    await dropDatabase(name).catch(() => undefined);
    throw error;
  }
  return {
    url,
    entityColumnsBefore,
    drop: () => dropDatabase(name),
  };
}

/** Drop a database this harness minted. Refuses any other name. */
async function dropDatabase(name: string): Promise<void> {
  if (!name.startsWith(PER_RUN_DATABASE_PREFIX)) {
    throw new Error(`refusing to drop "${name}": not a per-run database name`);
  }
  await withClient(serverUrl("postgres"), (client) =>
    client.unsafe(`drop database if exists "${name}" with (force)`),
  );
}

/** A fresh stack per test, so no assertion can see another test's rows. */
export async function newStack(client: Sql, slug: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    insert into stacks (name, domain) values (${slug}, ${slug}) returning id`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("stack insert returned no row");
  return id;
}

/** Two entities in one stack, returning their ids in insertion order. */
export async function twoEntities(
  client: Sql,
  stackId: string,
  names: readonly [string, string],
): Promise<readonly [string, string]> {
  const rows = await client<{ id: string }[]>`
    insert into ontology_entities (stack_id, name, type) values
      (${stackId}, ${names[0]}, 'SYSTEM'), (${stackId}, ${names[1]}, 'SYSTEM')
    returning id`;
  const ids = rows.map((row) => row.id);
  if (ids[0] === undefined || ids[1] === undefined) throw new Error("entity insert lost a row");
  return [ids[0], ids[1]];
}
