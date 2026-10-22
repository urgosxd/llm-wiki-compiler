/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-harness.ts
 * @description Shared pool setup, fixtures and app builder for the split `routes/ingest-*` test files.
 *
 * The `vi.hoisted` provider configuration stays in each test file: it must run
 * before `../config.js` is imported, which a helper module cannot guarantee.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import type { Sql } from "postgres";
import { afterAll, expect, vi } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import type { Database } from "../db.js";
import { createIngestRouter } from "./ingest.js";
import type { IngestRouterDependencies } from "./ingest.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `ingest-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix}. The
 * files run in parallel against one database and cleanup deletes by prefix, so a
 * shared prefix would let one file delete another's fixtures mid-test.
 */
let domainPrefix = "w2ex-ingest-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `w2ex-ingest-${suffix}-`;
}

export const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

export const RESPONSE_KEYS = [
  "document_id",
  "chunks_created",
  "entities_extracted",
  "entities_in_stack",
  "relationships_extracted",
  "relationships_written",
  "relationships_in_stack",
  "truncated",
  "descriptions_synthesized",
] as const;

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
  console.warn(`[ingest.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export const writtenFiles = new Set<string>();

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
      (select count(*) from document_chunks
        where stack_id in (select id from stacks where domain like ${`${domainPrefix}%`}))
      + (select count(*) from ontology_entities
        where stack_id in (select id from stacks where domain like ${`${domainPrefix}%`}))
      as total
  `);
  // The sum of two `count(*)` values is `numeric`, which postgres-js delivers as
  // a string; `Number` is the narrowing, and a missing row is treated as "cleanup
  // did not run" rather than "clean".
  const total = rows[0]?.total;
  return total === undefined ? -1 : Number(total);
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);

  const { unlink } = await import("node:fs/promises");
  for (const path of writtenFiles) {
    await unlink(resolve(process.cwd(), path)).catch(() => undefined);
  }

  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

export function createTestApp(): Express {
  const deps: IngestRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface.
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  };

  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error && err.message !== "" ? err.message : "Internal Server Error";
    res.status(500).type("text/plain").send(message);
  });
  return app;
}

export async function createStack(overrides: { synthesize?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await database().execute(sql`
    insert into stacks (id, name, domain, synthesize_descriptions)
    values (
      ${id}, ${`w2ex ${suffix}`}, ${`${domainPrefix}${suffix}`},
      ${overrides.synthesize ?? false}
    )
  `);
  return id;
}

export async function createDocument(
  stackId: string,
  content: string | Uint8Array,
  filename = "fixture.txt",
): Promise<string> {
  const documentId = randomUUID();
  const relative = `uploads/${stackId}/${documentId}.txt`;
  const absolute = resolve(process.cwd(), relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  writtenFiles.add(relative);

  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
  await database().execute(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes, source_hash
    )
    values (${documentId}, ${stackId}, ${filename}, ${relative}, ${bytes}, ${randomUUID()})
  `);
  return documentId;
}

export function ingestUrl(stackId: string, documentId: string, query = ""): string {
  return `/stacks/${stackId}/documents/${documentId}/ingest${query}`;
}

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
