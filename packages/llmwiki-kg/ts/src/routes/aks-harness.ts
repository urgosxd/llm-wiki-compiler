/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-harness.ts
 * @description Shared pool setup, fixtures and app builder for the split `routes/aks-*` test files.
 *
 * Not a test file, so the runner does not collect it. The `vi.hoisted` provider
 * configuration still lives in each test file: it must run before `../config.js`
 * is imported, which a helper module cannot guarantee.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Express } from "express";
import type { Sql } from "postgres";
import { afterAll, expect, vi } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import { createClient, createDatabase, createRequestTransactionWrapper } from "../db.js";
import { createApp } from "../server.js";
import type { Database } from "../db.js";
import { withFixtureTenant } from "./fixture-tenant.js";

import type { AksRouterDependencies } from "./aks.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `aks-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix} before
 * touching the database. The files run in parallel against one database, and the
 * cleanup deletes by prefix, so without a disjoint prefix one file would delete
 * another's fixtures mid-test.
 */
let domainPrefix = "w2aks-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `w2aks-${suffix}-`;
}

export const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

vi.hoisted(() => {
  if (process.env["AKS_TEST_GATEWAY"] !== "1") {
    process.env["EXTRACTION_PROVIDER"] ??= "gateway";
    process.env["EMBEDDING_PROVIDER"] ??= "gateway";
    process.env["GATEWAY_URL"] ??= "https://gateway.invalid/v1";
    process.env["GATEWAY_API_KEY"] ??= "test-key-not-a-credential";
    process.env["EMBEDDING_MODEL"] ??= "hf:nomic-ai/nomic-embed-text-v1.5";
    process.env["EMBEDDING_DIM"] ??= "768";
    process.env["EXTRACTION_MODEL"] ??= "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  }
});

export const ENTITY_KEYS = [
  "id",
  "name",
  "type",
  "description",
  "properties",
  "confidence",
  "contributing_documents",
  "last_seen_at",
  "source",
] as const;

export const SOURCE_KEYS = [
  "document_id",
  "connector_id",
  "source_kind",
  "extracted_at",
  "model",
  "verified",
  "pipeline",
] as const;

export const RELATIONSHIP_KEYS = [
  "id",
  "from_entity_id",
  "to_entity_id",
  "type",
  "description",
  "confidence",
  "source",
] as const;

export const BUNDLE_KEYS = [
  "aks_version",
  "domain",
  "stack_id",
  "stack_name",
  "compiled_at",
  "scope",
  "entity_count",
  "relationship_count",
  "document_count",
  "compilation_strategy",
  "documents",
  "entities",
  "relationships",
] as const;

export const TRAVERSE_KEYS = ["start", "max_depth", "steps", "entity_count"] as const;

export const TRAVERSE_STEP_KEYS = [
  "from_entity",
  "relationship",
  "to_entity",
  "depth",
  "confidence",
] as const;

export const CONTEXT_KEYS = [
  "query",
  "entities",
  "relationships",
  "traversal_path",
  "reasoning",
  "confidence",
  "source_type",
] as const;

export const state: {
  client?: Sql;
  database?: Database;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    state.client = candidate;
    state.database = createDatabase(candidate);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

if (state.skipReason !== false) {
  console.warn(`[aks.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export async function deleteFixtureRows(): Promise<void> {
  const prefixed = sql`select id from stacks where domain like ${`${domainPrefix}%`}`;

  await database().execute(
    sql`delete from entity_source_documents where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_relationships where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_entities where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from document_chunks where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from stack_documents where stack_id in (${prefixed})`,
  );
  await database().execute(sql`delete from stacks where domain like ${`${domainPrefix}%`}`);
}

export async function countFixtureRows(): Promise<number> {
  const rows = await database().execute<{ total: number }>(sql`
    select
      (select count(*) from ontology_entities
        where stack_id in (select id from stacks where domain like ${`${domainPrefix}%`}))
      + (select count(*) from ontology_relationships
        where stack_id in (select id from stacks where domain like ${`${domainPrefix}%`}))
      + (select count(*) from document_chunks
        where stack_id in (select id from stacks where domain like ${`${domainPrefix}%`}))
      + (select count(*) from stack_documents
        where stack_id in (select id from stacks where domain like ${`${domainPrefix}%`}))
      as total
  `);
  // The sum of `count(*)` values is `numeric`, which postgres-js delivers as a
  // string; `Number` is the narrowing. A missing row means "cleanup did not run".
  const total = rows[0]?.total;
  return total === undefined ? -1 : Number(total);
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);

  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

export function createTestApp(): Express {
  const deps: AksRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface (`auth.test.ts`).
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  };
  return createApp(deps);
}

export interface Fixture {
  readonly stackId: string;
  readonly domain: string;
  readonly entityIds: { readonly gateway: string; readonly model: string; readonly limit: string };
  readonly relationshipIds: { readonly uses: string; readonly has: string };
  readonly documentId: string;
}

export async function createFixture(options: { withDocument?: boolean } = {}): Promise<Fixture> {
  const ids = fixtureIds();
  const withDocument = options.withDocument !== false;

  // One transaction for the whole seeding: every row below is tenant-scoped, and
  // `set_config(..., true)` dies with its transaction, so the binding has to cover
  // all of them rather than just the Stack INSERT.
  await withFixtureTenant(database(), { stackId: ids.stackId, domain: ids.domain }, async (tx) => {
    await insertFixtureStack(ids, tx);
    if (withDocument) {
      await insertFixtureDocument(ids, tx);
    }
    await insertFixtureEntities(ids, tx);
    await insertFixtureGraph(ids, tx);
    if (withDocument) {
      await linkFixtureDocument(ids, tx);
    }
  });

  return {
    stackId: ids.stackId,
    domain: ids.domain,
    entityIds: { gateway: ids.gateway, model: ids.model, limit: ids.limit },
    relationshipIds: { uses: ids.uses, has: ids.has },
    documentId: ids.documentId,
  };
}

/** The ids one fixture is built from, generated up front. */
interface FixtureIds {
  readonly stackId: string;
  readonly domain: string;
  readonly documentId: string;
  readonly gateway: string;
  readonly model: string;
  readonly limit: string;
  readonly uses: string;
  readonly has: string;
}

/** Generates every id a fixture needs, and its unique domain. */
function fixtureIds(): FixtureIds {
  const domain = `${domainPrefix}${randomUUID().slice(0, 8)}`;
  return {
    stackId: randomUUID(),
    domain,
    documentId: randomUUID(),
    gateway: randomUUID(),
    model: randomUUID(),
    limit: randomUUID(),
    uses: randomUUID(),
    has: randomUUID(),
  };
}

/** Inserts the Stack row. */
async function insertFixtureStack(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into stacks (id, name, domain, description, scope, compilation_strategy)
    values (${ids.stackId}, ${`w2aks ${ids.domain.slice(-8)}`}, ${ids.domain}, ${"fixture stack"}, ${"stack"}, ${"incremental"})
  `);
}

/** Inserts the one document the fixture optionally carries. */
async function insertFixtureDocument(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes, source_hash,
      truncated, original_length, audit
    )
    values (
      ${ids.documentId}, ${ids.stackId}, ${"fixture.txt"},
      ${"uploads/fixture.txt"}, ${120}, ${`hash-${ids.documentId}`},
      ${false}, ${120}, ${null}
    )
  `);
}

/** Inserts the three entities the query endpoints read. */
async function insertFixtureEntities(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into ontology_entities (
      id, stack_id, name, type, description, properties, confidence,
      verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${ids.gateway}, ${ids.stackId}, ${"Gateway"}, ${"SYSTEM"},
       ${"Routes model traffic"}, ${JSON.stringify({ tier: "edge" })}::jsonb, ${0.9},
       ${true}, ${"model-a"}, ${"document"},
       ${"llamaindex-schema-extraction"}),
      (${ids.model}, ${ids.stackId}, ${"Embedding Model"}, ${"TECHNOLOGY"},
       ${null}, ${"{}"}::jsonb, ${0.6},
       ${false}, ${"model-a"}, ${"document"},
       ${"llamaindex-schema-extraction"}),
      (${ids.limit}, ${ids.stackId}, ${"Rate Limit"}, ${"CONCEPT"},
       ${"Caps throughput"}, ${"{}"}::jsonb, ${0.4},
       ${false}, ${null}, ${"document"}, ${"llamaindex-schema-extraction"})
  `);
}

/** Inserts the two edges the traverse tests walk. */
async function insertFixtureGraph(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into ontology_relationships (
      id, stack_id, from_entity_id, to_entity_id, type, description,
      confidence, verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${ids.uses}, ${ids.stackId}, ${ids.gateway}, ${ids.model}, ${"USED_BY"},
       ${"gateway uses model"}, ${0.75}, ${false}, ${"model-a"},
       ${"document"}, ${"llamaindex-schema-extraction"}),
      (${ids.has}, ${ids.stackId}, ${ids.model}, ${ids.limit}, ${"HAS"},
       ${"model has limit"}, ${0.55}, ${true}, ${"model-b"},
       ${"document"}, ${"llamaindex-schema-extraction"})
  `);
}

/** Links the document to the gateway entity. */
async function linkFixtureDocument(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into entity_source_documents (entity_id, document_id, stack_id)
    values (${ids.gateway}, ${ids.documentId}, ${ids.stackId})
  `);
}
export function qs(pairs: Record<string, string>): string {
  return new URLSearchParams(pairs).toString();
}

export function fixtureDomainNeverCreated(): string {
  return `${domainPrefix}absent`;
}

export function unitVector(axis: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[axis] = 1;
  return vector;
}

export function oppositeVector(axis: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[axis] = -1;
  return vector;
}

export function orthogonallyMixed(): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[0] = 1;
  vector[1] = Math.sqrt(3);
  const norm = Math.hypot(1, Math.sqrt(3));
  return vector.map((component) => component / norm);
}
