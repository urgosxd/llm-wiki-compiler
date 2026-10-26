/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-harness.ts
 * @description Shared pool setup, fixtures and zip readers for the split `routes/pages-*` test files.
 *
 * The `vi.hoisted` provider configuration and `vi.mock` of `core/llm_clients.js`
 * stay in each test file: they must be in place before the modules under test are
 * imported, which a helper module cannot guarantee.
 */
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { sql } from "drizzle-orm";
import type { Express } from "express";
import type { Sql } from "postgres";
import { afterAll, expect } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import { createApp } from "../server.js";
import type { Database } from "../db.js";
import { FixtureStacks, withFixtureTenant } from "./fixture-tenant.js";

import type { PageEntityRow, PageRelationshipRow } from "../core/page_generator.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `pages-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix}. The
 * files run in parallel against one database and the cleanup deletes by prefix,
 * so a shared prefix would let one file delete another's fixtures mid-test.
 */
let domainPrefix = "w2pg-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `w2pg-${suffix}-`;
}

/** The current domain prefix, for a describe body that builds its own domain. */
export function currentDomainPrefix(): string {
  return domainPrefix;
}

export const ENTITY_PAGE_KEYS = [
  "entity_name",
  "markdown",
  "generated_at",
  "source_entity_id",
  "graph_version",
  "source_type",
  "cached",
] as const;

export const BACKFILL_KEYS = [
  "stack_id",
  "entities_considered",
  "entities_synthesized",
  "entities_skipped",
] as const;

export const SYNTHESIZE_ONE_KEYS = ["entity_name", "description", "synthesized"] as const;

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
  console.warn(`[pages.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export async function deleteFixtureRows(): Promise<void> {
  // One bound delete per Stack; the child tables follow through `on delete cascade`,
  // verified to fire under RLS. The old prefix deletes could not be bound, and under
  // RLS a bound prefix delete removes only the bound domain's row while reporting
  // success.
  await fixtureStacks.deleteAll(database());
}

export async function countFixtureRows(): Promise<number> {
  // Summed per tracked Stack: a count across several Stacks has no single tenant to
  // bind, so the old prefix query cannot see them under RLS. Callers get the same
  // number.
  return fixtureStacks.sum(database(), async (tx, stackId) => {
    const rows = await tx.execute<{ total: number }>(sql`
      select
        (select count(*) from ontology_entities where stack_id = ${stackId})
        + (select count(*) from ontology_relationships where stack_id = ${stackId})
        + (select count(*) from document_chunks where stack_id = ${stackId})
        + (select count(*) from stack_documents where stack_id = ${stackId})
        + (select count(*) from entity_pages where stack_id = ${stackId})
        as total
    `);
    const counted = rows[0]?.total;
    return counted === undefined ? -1 : Number(counted);
  });
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);

  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

export function createTestApp(): Express {
  const deps = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface (`auth.test.ts`).
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  };
  return createApp(deps);
}

export interface Fixture {
  readonly stackId: string;
  readonly stackName: string;
  readonly domain: string;
  readonly entityIds: { readonly billing: string; readonly gateway: string; readonly limit: string };
  readonly documentId: string;
}

/** Fixture Stacks this file created, for per-tenant cleanup and counting. */
const fixtureStacks = new FixtureStacks();

export async function createFixture(): Promise<Fixture> {
  const ids = fixtureIds();
  // One transaction for the whole seed. Every row below is tenant-scoped and
  // `set_config(..., true)` dies with its transaction, so the binding has to cover all
  // of them — not just the Stack INSERT.
  await withFixtureTenant(database(), { stackId: ids.stackId, domain: ids.domain }, async (tx) => {
    await insertFixtureStack(ids, tx);
    await insertFixtureEntities(ids, tx);
    await insertFixtureGraph(ids, tx);
  });
  fixtureStacks.add(ids.stackId);
  return {
    stackId: ids.stackId,
    stackName: ids.stackName,
    domain: ids.domain,
    entityIds: { billing: ids.billing, gateway: ids.gateway, limit: ids.limit },
    documentId: ids.documentId,
  };
}

/** The ids one fixture is built from, generated up front. */
interface FixtureIds {
  readonly stackId: string;
  readonly domain: string;
  readonly stackName: string;
  readonly documentId: string;
  readonly billing: string;
  readonly gateway: string;
  readonly limit: string;
}

/** Generates every id a fixture needs, and its unique domain. */
function fixtureIds(): FixtureIds {
  const stackId = randomUUID();
  const domain = `${domainPrefix}${randomUUID().slice(0, 8)}`;
  return {
    stackId,
    domain,
    stackName: `w2pg ${domain.slice(-8)}`,
    documentId: randomUUID(),
    billing: randomUUID(),
    gateway: randomUUID(),
    limit: randomUUID(),
  };
}

/** Inserts the Stack row and its one document. */
async function insertFixtureStack(ids: FixtureIds, tx: Database): Promise<void> {
  // Runs on the caller's bound transaction: `createFixture` opens one covering the
  // whole seed, because `set_config(..., true)` is transaction-local.
  await tx.execute(sql`
    insert into stacks (id, name, domain, description, scope, compilation_strategy)
    values (${ids.stackId}, ${ids.stackName}, ${ids.domain}, ${"pages fixture"}, ${"stack"}, ${"incremental"})
  `);
  await tx.execute(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes, source_hash,
      truncated, original_length, audit
    )
    values (
      ${ids.documentId}, ${ids.stackId}, ${"w2pg-runbook.txt"},
      ${"uploads/w2pg-runbook.txt"}, ${240}, ${`hash-${ids.documentId}`},
      ${false}, ${240}, ${null}
    )
  `);
}

/** Inserts the three entities the page endpoints read. */
async function insertFixtureEntities(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into ontology_entities (
      id, stack_id, name, type, description, properties, confidence,
      verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${ids.billing}, ${ids.stackId}, ${"Billing Service"}, ${"SYSTEM"},
       ${"Processes invoices for customers"}, ${JSON.stringify({ tier: "edge" })}::jsonb, ${0.9},
       ${true}, ${"model-a"}, ${"document"}, ${"llamaindex-schema-extraction"}),
      (${ids.gateway}, ${ids.stackId}, ${"Payment Gateway"}, ${"SYSTEM"},
       ${null}, ${"{}"}::jsonb, ${0.7},
       ${false}, ${"model-a"}, ${"document"}, ${"llamaindex-schema-extraction"}),
      (${ids.limit}, ${ids.stackId}, ${"Rate Limit"}, ${"CONCEPT"},
       ${"Caps throughput"}, ${"{}"}::jsonb, ${0.4},
       ${false}, ${null}, ${"document"}, ${"llamaindex-schema-extraction"})
  `);
}

/** Inserts the edges, the source-document link and one chunk. */
async function insertFixtureGraph(ids: FixtureIds, tx: Database): Promise<void> {
  await tx.execute(sql`
    insert into ontology_relationships (
      id, stack_id, from_entity_id, to_entity_id, type, description,
      confidence, verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${randomUUID()}, ${ids.stackId}, ${ids.billing}, ${ids.gateway}, ${"USES"},
       ${"billing uses gateway"}, ${0.75}, ${false}, ${"model-a"},
       ${"document"}, ${"llamaindex-schema-extraction"}),
      (${randomUUID()}, ${ids.stackId}, ${ids.limit}, ${ids.billing}, ${"CAPS"},
       ${"limit caps billing"}, ${0.55}, ${true}, ${"model-b"},
       ${"document"}, ${"llamaindex-schema-extraction"})
  `);
  await tx.execute(sql`
    insert into entity_source_documents (entity_id, document_id, stack_id)
    values (${ids.billing}, ${ids.documentId}, ${ids.stackId})
  `);
  await tx.execute(sql`
    insert into document_chunks (
      id, document_id, stack_id, chunk_index, content, content_hash, token_count
    )
    values (
      ${randomUUID()}, ${ids.documentId}, ${ids.stackId}, 0,
      ${"The Billing Service processes invoices and calls the Payment Gateway to charge cards."},
      ${`chunk-${ids.documentId}`}, ${16}
    )
  `);
}
export interface ParsedEntry {
  readonly name: string;
  readonly content: string;
  readonly compressionMethod: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly flagBits: number;
  readonly createSystem: number;
  readonly externalAttr: number;
}

export function readZipArchive(archive: Buffer): ParsedEntry[] {
  const endOffset = findEndRecord(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);

  const entries: ParsedEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const parsed = readCentralEntry(archive, centralOffset, index);
    entries.push(parsed.entry);
    centralOffset += parsed.recordLength;
  }
  return entries;
}

/** Locates the end-of-central-directory record, scanning backwards. */
function findEndRecord(archive: Buffer): number {
  const endSignature = 0x06054b50;
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) {
      return offset;
    }
  }
  throw new Error("no end-of-central-directory record found");
}

/** One central-directory record and how long it is. */
interface ParsedCentralEntry {
  readonly entry: ParsedEntry;
  readonly recordLength: number;
}

/** Reads one entry's payload through its local header. */
function readLocalPayload(
  archive: Buffer,
  localOffset: number,
  name: string,
  compressedSize: number,
): Buffer {
  if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`local header for ${name} has a bad signature`);
  }
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  return archive.subarray(dataStart, dataStart + compressedSize);
}

/** Reads one central-directory record and its local header. */
function readCentralEntry(
  archive: Buffer,
  centralOffset: number,
  index: number,
): ParsedCentralEntry {
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error(`central directory entry ${String(index)} has a bad signature`);
  }
  const createdBy = archive.readUInt16LE(centralOffset + 4);
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const crc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const externalAttr = archive.readUInt32LE(centralOffset + 38);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const name = archive
    .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
    .toString("utf8");

  const raw = readLocalPayload(archive, localOffset, name, compressedSize);

  return {
    entry: {
      name,
      content: (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"),
      compressionMethod: method,
      crc,
      compressedSize,
      uncompressedSize,
      flagBits: flags,
      createSystem: createdBy >> 8,
      externalAttr,
    },
    recordLength: 46 + nameLength + extraLength + commentLength,
  };
}
export function entityRow(overrides: Partial<PageEntityRow> = {}): PageEntityRow {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    stack_id: "10000000-0000-4000-8000-0000000000ff",
    name: "Billing Service",
    type: "SYSTEM",
    description: "Processes invoices",
    properties_text: '{"tier": "edge"}',
    confidence: 0.7,
    verified: true,
    last_seen_at: null,
    ...overrides,
  };
}

export function relationshipRow(
  overrides: Partial<PageRelationshipRow> = {},
): PageRelationshipRow {
  return {
    type: "USES",
    confidence: 0.75,
    description: null,
    other_name: "Payment Gateway",
    other_type: "SYSTEM",
    direction: "outgoing",
    ...overrides,
  };
}
