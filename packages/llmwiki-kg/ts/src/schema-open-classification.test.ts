/**
 * @file packages/llmwiki-kg/ts/src/schema-open-classification.test.ts
 * @description The open-classification schema, asserted against a real database.
 *
 * ## What this suite is allowed to prove
 *
 * Only what a caller can observe: the columns, constraints and indexes the database
 * carries (through `information_schema` and `pg_catalog`), the row values it holds,
 * and the INSERT/UPSERT statements the application really runs. No private helper or
 * internal shape is asserted, so a refactor that keeps the contract keeps this green.
 *
 * ## Why a second, bare database exists
 *
 * `createSuiteDatabase` applies the FULL, already-migrated schema, so it cannot
 * represent a database that predates this migration. The upgrade path therefore gets
 * a database this file mints itself: the PRE-migration shape of the tables the
 * migration touches, real rows carrying `verified`, `confidence`, `properties`,
 * `source_kind` and `pipeline`, and then the migration file an operator would run.
 * Without it, "no existing row is lost" would be an assumption about SQL nobody
 * executed.
 *
 * The bare database's name is minted in the per-run form on purpose: if this process
 * is killed before teardown, the fixture's reaper recognises the name and pid and
 * collects it, exactly like its own debris.
 *
 * ## The pre-migration control
 *
 * The legacy column list is captured BEFORE the migration runs and asserted absent
 * afterwards, so "the migration is what added this" is a check and not a story. A
 * suite that only asserted the final shape would also pass against a database where
 * the migration had silently done nothing.
 *
 * Row-level security is asserted separately rather than compared: the bare database
 * has no `migration_rls_tenancy.sql` applied, so the tenancy state of the shared
 * tables legitimately differs, while the two tables THIS migration creates must be
 * secured on both paths.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "./schema.js";
import {
  PER_RUN_DATABASE_PREFIX,
  perRunDatabase,
  withClient,
} from "./testing/per-run-database.js";

/** The server a suite database is provisioned on: the same host the other suites use. */
const TEST_SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** This process's database, built from `schema.sql` and the migration list. */
const FRESH = await perRunDatabase(TEST_SERVER_URL);

/** A pre-migration database this file mints, because the fixture only builds current ones. */
const LEGACY_NAME = `${PER_RUN_DATABASE_PREFIX}${Date.now().toString(36)}_${process.pid}_${randomUUID()
  .replace(/-/g, "")
  .slice(0, 12)}`;

/** The same server, retargeted: `/postgres` is always present, and `LEGACY_NAME` is not. */
function serverUrl(database: string): string {
  const url = new URL(TEST_SERVER_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The migration under test, read from the file an operator would run. */
const MIGRATION_SQL = await readFile(
  new URL("../../db/migration_open_kg_classification.sql", import.meta.url),
  "utf-8",
);

/** The tables this migration touches: the shape both paths must agree on. */
const TOUCHED_TABLES = [
  "stacks",
  "ontology_entities",
  "ontology_relationships",
  "kg_evidence",
  "kg_classification_log",
] as const;

/** Column names of one `public` table, sorted. */
async function columnNames(client: Sql, table: string): Promise<string[]> {
  const rows = await client<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by column_name
  `;
  return rows.map((row) => row.column_name);
}

/** Drizzle's database column names for one table, sorted. */
function drizzleColumnNames(table: PgTable): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name).sort();
}

/** The drizzle tables that must mirror the database, paired by table name. */
const TABLE_PAIRS: readonly (readonly [string, PgTable])[] = [
  ["stacks", schema.stacks],
  ["ontology_entities", schema.ontologyEntities],
  ["ontology_relationships", schema.ontologyRelationships],
  ["kg_evidence", schema.kgEvidence],
  ["kg_classification_log", schema.kgClassificationLog],
];

/** Everything about one table that the clean-install and upgrade paths must agree on. */
async function tableShape(client: Sql, table: string): Promise<string> {
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
async function databaseShape(client: Sql): Promise<Record<string, string>> {
  const shape: Record<string, string> = {};
  for (const table of TOUCHED_TABLES) shape[table] = await tableShape(client, table);
  return shape;
}

/**
 * The PRE-migration shape of exactly the tables this migration touches.
 *
 * Copied from `db/schema.sql` at the commit before this migration, reduced to the
 * five tables it alters or references; `stack_documents` and `document_chunks` carry
 * only a primary key because the migration only needs them as foreign-key targets.
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

/** The legacy database as it looked BEFORE the migration ran. */
const before: { entityColumns: string[] } = { entityColumns: [] };

/** Every migration-relevant row value, as a stable string, for "nothing changed" checks. */
async function rowSnapshot(client: Sql): Promise<string> {
  const entities = await client<{ row: string | null }[]>`
    select json_agg(row_to_json(t) order by t.id)::text as row from (
      select id, name, identity_key, classification_state, canonical_type, proposed_type,
             support_state, verified, confidence, properties, source_kind, pipeline
      from ontology_entities
    ) t
  `;
  const relationships = await client<{ row: string | null }[]>`
    select json_agg(row_to_json(t) order by t.id)::text as row from (
      select id, identity_key, predicate, classification_state, canonical_type,
             support_state, compatibility, verified, confidence
      from ontology_relationships
    ) t
  `;
  return JSON.stringify([entities[0]?.row ?? null, relationships[0]?.row ?? null]);
}

beforeAll(async () => {
  await withClient(serverUrl("postgres"), (client) =>
    client.unsafe(`create database "${LEGACY_NAME}"`),
  );
  await withClient(serverUrl(LEGACY_NAME), async (client) => {
    await client.unsafe(LEGACY_SCHEMA_SQL);
    before.entityColumns = await columnNames(client, "ontology_entities");
    await client.unsafe(MIGRATION_SQL);
  });
});

afterAll(async () => {
  await withClient(serverUrl("postgres"), (client) =>
    client.unsafe(`drop database if exists "${LEGACY_NAME}" with (force)`),
  );
});

describe("the migration", () => {
  it("adds every open-classification column to a pre-migration database", async () => {
    await withClient(serverUrl(LEGACY_NAME), async (client) => {
      expect(before.entityColumns).not.toContain("classification_state");
      expect(before.entityColumns).not.toContain("identity_key");
      expect(await columnNames(client, "ontology_entities")).toEqual(
        expect.arrayContaining([
          "classification_state",
          "canonical_type",
          "proposed_type",
          "support_state",
          "jev_choice",
          "jev_confidence",
          "jev_top_probability",
          "jev_model",
          "jev_classified_at",
          "catalog_version",
          "classifier_version",
          "classification_updated_at",
          "identity_key",
        ]),
      );
      expect(await columnNames(client, "ontology_relationships")).toEqual(
        expect.arrayContaining([
          "predicate",
          "canonical_type",
          "classification_state",
          "support_state",
          "compatibility",
          "jev_choice",
          "jev_confidence",
          "jev_top_probability",
          "jev_model",
          "jev_classified_at",
          "catalog_version",
          "classifier_version",
          "classification_updated_at",
          "identity_key",
        ]),
      );
      expect(await columnNames(client, "stacks")).toEqual(
        expect.arrayContaining(["type_catalog", "catalog_version"]),
      );
    });
  });

  it("agrees with a database built from schema.sql", async () => {
    const migrated = await withClient(serverUrl(LEGACY_NAME), databaseShape);
    const fresh = await withClient(FRESH.url, databaseShape);
    expect(migrated).toEqual(fresh);
  });

  it("mirrors every database column in the drizzle definitions", async () => {
    await withClient(FRESH.url, async (client) => {
      for (const [table, pgTable] of TABLE_PAIRS) {
        expect({ table, columns: drizzleColumnNames(pgTable) }).toEqual({
          table,
          columns: await columnNames(client, table),
        });
      }
    });
  });

  it("secures the evidence and history tables for tenancy on both paths", async () => {
    for (const url of [FRESH.url, serverUrl(LEGACY_NAME)]) {
      const secured = await withClient(url, (client) =>
        client<{ table: string; relrowsecurity: boolean }[]>`
          select c.relname as table, c.relrowsecurity from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in ('kg_evidence', 'kg_classification_log')
          order by c.relname`,
      );
      expect(secured).toEqual([
        { table: "kg_classification_log", relrowsecurity: true },
        { table: "kg_evidence", relrowsecurity: true },
      ]);
    }
  });

  it("can be applied twice without changing a single row", async () => {
    const first = await withClient(serverUrl(LEGACY_NAME), rowSnapshot);
    expect(first).not.toBe(JSON.stringify([null, null]));
    await withClient(serverUrl(LEGACY_NAME), (client) => client.unsafe(MIGRATION_SQL));
    expect(await withClient(serverUrl(LEGACY_NAME), rowSnapshot)).toBe(first);
  });
});

describe("the backfill", () => {
  it("keeps every legacy row and marks it classified with its old type", async () => {
    const rows = await withClient(serverUrl(LEGACY_NAME), (client) =>
      client<{ classification_state: string; canonical_type: string; support_state: string }[]>`
        select classification_state, canonical_type, proposed_type, support_state
        from ontology_entities order by name`,
    );
    expect(rows).toHaveLength(2);
    // `supported` would fabricate an evidence judgement nobody ever made.
    expect(rows.map((row) => row.classification_state)).toEqual(["classified", "classified"]);
    expect(rows.map((row) => row.canonical_type)).toEqual(["SYSTEM", "SYSTEM"]);
    expect(rows.map((row) => row.support_state)).toEqual(["uncertain", "uncertain"]);
  });

  it("leaves review state, confidence, properties and pipeline untouched", async () => {
    const rows = await withClient(serverUrl(LEGACY_NAME), (client) =>
      client<
        {
          name: string;
          verified: boolean;
          confidence: number;
          properties: unknown;
          source_kind: string;
          pipeline: string;
        }[]
      >`
        select name, verified, confidence, properties, source_kind, pipeline
        from ontology_entities order by id`,
    );
    expect(rows.map((row) => row.verified)).toEqual([true, false]);
    expect(rows.map((row) => Number(row.confidence))).toEqual([0.9, 0.7]);
    expect(rows.map((row) => JSON.stringify(row.properties))).toEqual([
      '{"tier":"edge"}',
      "{}",
    ]);
    expect(rows.map((row) => row.source_kind)).toEqual(["backfeed", "document"]);
    expect(rows.map((row) => row.pipeline)).toEqual(["human-review", "llamaindex-schema-extraction"]);
  });

  it("gives relationships their original predicate as identity, and keeps verified", async () => {
    const rows = await withClient(serverUrl(LEGACY_NAME), (client) =>
      client<{ predicate: string; identity_key: string; canonical_type: string; verified: boolean }[]>`
        select predicate, identity_key, canonical_type, verified from ontology_relationships`,
    );
    expect(rows).toEqual([
      { predicate: "USES", identity_key: "uses", canonical_type: "USES", verified: true },
    ]);
  });

  it("keeps case-variant names apart instead of merging them", async () => {
    const keys = await withClient(serverUrl(LEGACY_NAME), (client) =>
      client<{ identity_key: string }[]>`
        select identity_key from ontology_entities order by identity_key`,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((row) => row.identity_key)).size).toBe(2);
    expect(keys[0]?.identity_key).toBe("gateway");
  });
});

/** A fresh stack per test, so no assertion can see another test's rows. */
async function newStack(client: Sql, slug: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    insert into stacks (name, domain) values (${slug}, ${slug}) returning id`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("stack insert returned no row");
  return id;
}

/** Two entities in one stack, returning their ids in insertion order. */
async function twoEntities(
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

describe("identity keys", () => {
  it("derives one for a writer that does not name the column", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await newStack(client, "identity-derive");
      await twoEntities(client, stackId, ["Billing Service", "Payment Gateway"]);
      const keys = await client<{ name: string; identity_key: string }[]>`
        select name, identity_key from ontology_entities
        where stack_id = ${stackId} order by name`;
      expect(keys).toEqual([
        { name: "Billing Service", identity_key: "billing service" },
        { name: "Payment Gateway", identity_key: "payment gateway" },
      ]);
    });
  });

  it("keeps homonyms apart and rejects a repeated identity key", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await newStack(client, "identity-homonyms");
      await client`
        insert into ontology_entities (stack_id, name, type, identity_key) values
          (${stackId}, 'Jordan', 'ROLE', 'jordan:employee-42'),
          (${stackId}, 'Jordan', 'ROLE', 'jordan:employee-99')`;
      await expect(
        client`insert into ontology_entities (stack_id, name, type, identity_key)
          values (${stackId}, 'Jordan', 'ROLE', 'jordan:employee-42')`,
      ).rejects.toThrow(/duplicate key value/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from ontology_entities where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(2);
    });
  });

  it("keeps two different free predicates apart between the same endpoints", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await newStack(client, "identity-predicates");
      const [from, to] = await twoEntities(client, stackId, ["Policy A", "Process B"]);
      await client`
        insert into ontology_relationships
          (stack_id, from_entity_id, to_entity_id, type, identity_key) values
          (${stackId}, ${from}, ${to}, 'deja sin efecto', 'deja sin efecto'),
          (${stackId}, ${from}, ${to}, 'revoca', 'revoca')`;
      await expect(
        client`insert into ontology_relationships
          (stack_id, from_entity_id, to_entity_id, type, identity_key)
          values (${stackId}, ${from}, ${to}, 'deja sin efecto', 'deja sin efecto')`,
      ).rejects.toThrow(/duplicate key value/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from ontology_relationships where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(2);
      const predicates = await client<{ predicate: string | null }[]>`
        select predicate from ontology_relationships where stack_id = ${stackId} order by type`;
      expect(predicates.map((row) => row.predicate)).toEqual(["deja sin efecto", "revoca"]);
    });
  });

  it("still resolves the edge upsert the consolidators run", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await newStack(client, "identity-edge-upsert");
      const [from, to] = await twoEntities(client, stackId, ["System C", "Role D"]);
      for (const confidence of [0.7, 0.9]) {
        await client`
          insert into ontology_relationships
            (stack_id, from_entity_id, to_entity_id, type, confidence)
          values (${stackId}, ${from}, ${to}, 'supports', ${confidence})
          on conflict (stack_id, from_entity_id, to_entity_id, type)
          do update set confidence = greatest(
            ontology_relationships.confidence, excluded.confidence)`;
      }
      const rows = await client<{ count: number; confidence: number }[]>`
        select count(*)::int as count, max(confidence)::float8 as confidence
        from ontology_relationships where stack_id = ${stackId}`;
      expect(rows[0]?.count).toBe(1);
      // `real` storage rounds: 0.9 comes back as 0.8999999761581421.
      expect(rows[0]?.confidence).toBeCloseTo(0.9, 6);
    });
  });
});

describe("evidence and classification history", () => {
  /** A stack, a document and a chunk to hang evidence off. */
  async function provenanceStack(client: Sql, slug: string): Promise<string> {
    const stackId = await newStack(client, slug);
    const documents = await client<{ id: string }[]>`
      insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
      values (${stackId}, 'policy.md', 'policy.md', 12, ${`hash-${slug}`}) returning id`;
    const documentId = documents[0]?.id;
    if (documentId === undefined) throw new Error("document insert returned no row");
    await client`
      insert into document_chunks (document_id, stack_id, chunk_index, content, content_hash)
      values (${documentId}, ${stackId}, 0, 'Deja sin efecto la política anterior.',
        ${`chunk-${slug}`})`;
    return stackId;
  }

  it("records provenance for a candidate source span", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await provenanceStack(client, "evidence-provenance");
      const chunk = await client<{ id: string; document_id: string }[]>`
        select id, document_id from document_chunks where stack_id = ${stackId} limit 1`;
      const chunkId = chunk[0]?.id;
      const documentId = chunk[0]?.document_id;
      if (chunkId === undefined || documentId === undefined) {
        throw new Error("chunk insert returned no row");
      }
      await client`
        insert into kg_evidence
          (stack_id, candidate_kind, candidate_ref, document_id, chunk_id, chunk_index,
           evidence_text, char_start, char_end, normalized_match, evidence_kind,
           model, pipeline_version, catalog_version)
        values (${stackId}, 'relationship', 'deja_sin_efecto', ${documentId}, ${chunkId}, 0,
          'Deja sin efecto la política anterior.', 0, 37, true, 'textual',
          'model-a', 'pipeline-1', '1.0.0')`;
      const rows = await client<{ candidate_kind: string; evidence_kind: string; chunk_index: number }[]>`
        select candidate_kind, evidence_kind, chunk_index from kg_evidence where stack_id = ${stackId}`;
      expect(rows).toEqual([
        { candidate_kind: "relationship", evidence_kind: "textual", chunk_index: 0 },
      ]);
    });
  });

  it("rejects an evidence kind or an inverted offset span", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await provenanceStack(client, "evidence-rejects");
      const documentId = (
        await client<{ id: string }[]>`select id from stack_documents where stack_id = ${stackId}`
      )[0]?.id;
      if (documentId === undefined) throw new Error("document insert returned no row");
      await expect(
        client`insert into kg_evidence
          (stack_id, candidate_kind, candidate_ref, document_id, evidence_text, evidence_kind)
          values (${stackId}, 'entity', 'cand-1', ${documentId}, 'quote', 'guess')`,
      ).rejects.toThrow(/valid_evidence_kind/);
      await expect(
        client`insert into kg_evidence
          (stack_id, candidate_kind, candidate_ref, document_id, evidence_text,
           char_start, char_end)
          values (${stackId}, 'entity', 'cand-2', ${documentId}, 'quote', 10, 4)`,
      ).rejects.toThrow(/valid_evidence_offsets/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from kg_evidence where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(0);
    });
  });

  it("records a classification transition and rejects an unknown state", async () => {
    await withClient(FRESH.url, async (client) => {
      const stackId = await newStack(client, "classification-log");
      await client`
        insert into kg_classification_log
          (stack_id, candidate_kind, candidate_ref, previous_state, new_state,
           previous_canonical_type, new_canonical_type, jev_choice, jev_confidence,
           catalog_version, classifier_version, reason)
        values (${stackId}, 'entity', 'billing-service', 'free_no_match', 'classified',
          null, 'Process', 'Process', 0.91, '1.0.0', 'jev-2026-09', 'catalog gained Process')`;
      await expect(
        client`insert into kg_classification_log
          (stack_id, candidate_kind, candidate_ref, new_state)
          values (${stackId}, 'entity', 'cand-2', 'probably_fine')`,
      ).rejects.toThrow(/valid_log_new_state/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from kg_classification_log where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(1);
    });
  });
});
