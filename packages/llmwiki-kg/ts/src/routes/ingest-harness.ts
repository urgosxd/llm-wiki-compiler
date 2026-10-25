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

/**
 * Every Stack this file's fixtures created, so cleanup and counting can target each
 * one by id.
 *
 * ## Why a registry instead of the domain prefix
 *
 * Cleanup used to delete by `domain like '<prefix>%'`. Under RLS that cursor has no
 * single tenant and cannot be bound: measured as the unprivileged role, a prefix
 * delete bound to one domain removes that domain's row and silently leaves its
 * siblings, so it reports success while cleaning only part of what it selected.
 *
 * Tracking ids makes every statement single-tenant. `stacks` is deleted by id with
 * the tenant bound, and the seven child tables go with it through
 * `on delete cascade` — verified to fire under RLS — so no child delete is needed.
 */
const fixtureStacks = new Set<string>();

/** Registers a Stack for cleanup. Called by {@link createStack}. */
export function trackFixtureStack(stackId: string): void {
  fixtureStacks.add(stackId);
}

export async function deleteFixtureRows(): Promise<void> {
  for (const stackId of fixtureStacks) {
    await database().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
      await tx.execute(sql`delete from stacks where id = ${stackId}`);
    });
  }
  fixtureStacks.clear();
}

export async function countFixtureRows(): Promise<number> {
  // Counted one bound Stack at a time rather than with one prefix query. A single
  // query across several Stacks has no single tenant to bind, so it cannot see them
  // under RLS; looping keeps the summed semantics identical while every statement
  // stays single-tenant. Callers see the same number as before.
  let total = 0;
  for (const stackId of fixtureStacks) {
    total += await database().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
      const rows = await tx.execute<{ total: number }>(sql`
        select
          (select count(*) from document_chunks where stack_id = ${stackId})
          + (select count(*) from ontology_entities where stack_id = ${stackId})
          as total
      `);
      // The sum of two `count(*)` values is `numeric`, which postgres-js delivers as
      // a string; `Number` is the narrowing.
      const counted = rows[0]?.total;
      return counted === undefined ? -1 : Number(counted);
    });
  }
  return total;
}

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
  const domain = `${domainPrefix}${suffix}`;
  // A fixture that inserts a Stack directly has to bind its domain first, for the
  // same reason `POST /stacks` does: the `stacks` write policy validates against
  // `app.stack_domain`. Without it this fails under RLS with
  // "new row violates row-level security policy for table stacks".
  //
  // The binding must share a TRANSACTION with the insert. `set_config(..., true)`
  // is transaction-local, so on a pooled client two bare `execute` calls can land
  // on different connections and the setting is already gone.
  await database().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_domain', ${domain}, true)`);
    await tx.execute(sql`
      insert into stacks (id, name, domain, synthesize_descriptions)
      values (${id}, ${`w2ex ${suffix}`}, ${domain}, ${overrides.synthesize ?? false})
    `);
  });
  trackFixtureStack(id);
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
  // `stack_documents` has no domain escape hatch: its write policy requires
  // `stack_id` to equal the bound tenant. As in `createStack` above, the binding
  // and the insert share a transaction because `set_config(..., true)` is
  // transaction-local and the pool may hand each statement a different connection.
  await database().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into stack_documents (
        id, stack_id, filename, storage_path, size_bytes, source_hash
      )
      values (${documentId}, ${stackId}, ${filename}, ${relative}, ${bytes}, ${randomUUID()})
    `);
  });
  return documentId;
}

export function ingestUrl(stackId: string, documentId: string, query = ""): string {
  return `/stacks/${stackId}/documents/${documentId}/ingest${query}`;
}

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
