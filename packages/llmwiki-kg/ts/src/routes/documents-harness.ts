/**
 * @file packages/llmwiki-kg/ts/src/routes/documents-harness.ts
 * @description Shared pool setup, fixtures and app builder for the split `routes/documents-*` test files.
 *
 * The `vi.hoisted` provider configuration stays in each test file.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import express from "express";
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
import type { Database } from "../db.js";

import { createDocumentsRouter } from "./documents.js";
import type { DocumentsRouterDependencies } from "./documents.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `documents-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix}. The
 * files run in parallel against one database and the cleanup deletes by prefix,
 * so a shared prefix would let one file delete another's fixtures mid-test.
 */
let domainPrefix = "w1doc-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `w1doc-${suffix}-`;
}

/** The current domain prefix, for a describe body that builds its own domain. */
export function currentDomainPrefix(): string {
  return domainPrefix;
}

export const RESPONSE_KEYS = [
  "id",
  "stack_id",
  "filename",
  "size_bytes",
  "content_type",
  "source_hash",
  "truncated",
  "original_length",
  "ingested_at",
  "audit",
] as const;

export const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

export const BOUNDARY = "w1doc-route-boundary";

export function rawMultipart(headerLines: string, data: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n${headerLines}\r\n\r\n${data}\r\n--${BOUNDARY}--\r\n`,
    "utf8",
  );
}

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
  console.warn(`[documents.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export async function tick(): Promise<void> {
  await new Promise((done) => setTimeout(done, 5));
}

export async function insertStack(domain: string): Promise<string> {
  const rows = await database().execute<{ id: string }>(sql`
    insert into stacks (name, domain)
    values (${"w1doc stack"}, ${domain})
    returning id
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stacks returned no row");
  }
  return row.id;
}

export async function countFixtureDocuments(): Promise<number> {
  const rows = await database().execute<{ total: number }>(sql`
    select count(*)::int as total
    from stack_documents d
    join stacks s on s.id = d.stack_id
    where s.domain like ${`${domainPrefix}%`}
  `);
  return rows[0]?.total ?? -1;
}

export async function fixtureStoragePaths(): Promise<string[]> {
  const rows = await database().execute<{ storage_path: string }>(sql`
    select d.storage_path
    from stack_documents d
    join stacks s on s.id = d.stack_id
    where s.domain like ${`${domainPrefix}%`}
  `);
  return rows.map((row) => row.storage_path);
}

export async function deleteFixtureFiles(): Promise<void> {
  for (const storagePath of await fixtureStoragePaths()) {
    await rm(resolve(process.cwd(), storagePath), { force: true });
  }
}

export async function deleteFixtureRows(): Promise<void> {
  await deleteFixtureFiles();
  await database().execute(
    sql`delete from stacks where domain like ${`${domainPrefix}%`}`,
  );
}

export async function countFixtureStacks(): Promise<number> {
  const rows = await database().execute<{ total: number }>(
    sql`select count(*)::int as total from stacks where domain like ${`${domainPrefix}%`}`,
  );
  return rows[0]?.total ?? -1;
}

export function deps(apiKey = ""): DocumentsRouterDependencies {
  return {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(
      parseConfig(apiKey === "" ? {} : { AKS_API_KEY: apiKey }),
    ),
  };
}

export function buildApp(apiKey = ""): Express {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createDocumentsRouter(deps(apiKey)));
  return app;
}

export let sequence = 0;

export function uniqueDomain(label: string): string {
  sequence += 1;
  return `${domainPrefix}${label}-${Date.now().toString(36)}-${String(sequence)}`;
}

export function expectOracleTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`expected a timestamp string, received ${typeof value}`);
  }
  expect(value).toHaveLength(27);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}

export function responseKeys(bodyText: string): string[] {
  const parsed: unknown = JSON.parse(bodyText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object response");
  }
  return Object.keys(parsed);
}

export function asRows(body: unknown): Record<string, unknown>[] {
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) {
    throw new Error("expected a JSON array response");
  }
  return body.map((item: unknown) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("expected every array element to be an object");
    }
    return Object.fromEntries(Object.entries(item));
  });
}

export function field(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null) {
    throw new Error("expected a JSON object response");
  }
  return Reflect.get(body, key);
}

afterAll(async () => {
  if (state.skipReason !== false) {
    return;
  }
  await deleteFixtureRows();
  expect(await countFixtureStacks()).toBe(0);
  expect(await countFixtureDocuments()).toBe(0);
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

afterAll(async () => {
  if (state.skipReason !== false) {
    return;
  }
  await deleteFixtureRows();
  expect(await countFixtureStacks()).toBe(0);
});

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
