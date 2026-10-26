/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-harness.ts
 * @description Shared pool setup, fixtures and app builder for the split `routes/backfeed-*` test files.
 */
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
import { FixtureStacks, withFixtureTenant } from "./fixture-tenant.js";
import { createApp } from "../server.js";
import { createBackfeedRouter } from "./backfeed.js";
import type { BackfeedRouterDependencies } from "./backfeed.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `backfeed-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix}. The
 * files run in parallel against one database and the cleanup deletes by prefix,
 * so a shared prefix would let one file delete another's fixtures mid-test.
 */
let domainPrefix = "w1bf-router-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `w1bf-router-${suffix}-`;
}

/** The current domain prefix, for a describe body that builds its own domain. */
export function currentDomainPrefix(): string {
  return domainPrefix;
}

export const ABSENT_UUID = "00000000-0000-0000-0000-000000000000";

export const ITEM_KEYS = [
  "id",
  "stack_id",
  "origin",
  "trigger_type",
  "proposal",
  "note",
  "metadata",
  "status",
  "reviewed_at",
  "reviewed_by",
  "review_note",
  "created_at",
] as const;

export const REQUIRED_NULLABLE_KEYS = [
  "note",
  "reviewed_at",
  "reviewed_by",
  "review_note",
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
  console.warn(`[backfeed.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

/** Fixture Stacks this file created, for per-tenant cleanup and counting. */
const fixtureStacks = new FixtureStacks();

/** Remembers a Stack so cleanup can target it by id. */
export function trackFixtureStack(stackId: string): void {
  fixtureStacks.add(stackId);
}

export async function deleteFixtureRows(): Promise<void> {
  // One bound delete per Stack; the child tables follow through
  // `on delete cascade`, verified to fire under RLS.
  await fixtureStacks.deleteAll(database());
}

export async function counts(): Promise<{
  stacks: number;
  queue: number;
  entities: number;
  relationships: number;
}> {
  // Counted per tracked Stack, in one bound transaction each: a count across several
  // Stacks has no single tenant to bind, so the old prefix query cannot see them under
  // RLS. The shape of the answer is unchanged, which is why the thirty call sites that
  // read it did not move.
  const totals = { stacks: 0, queue: 0, entities: 0, relationships: 0 };
  for (const stackId of fixtureStacks.ids()) {
    totals.stacks += 1;
    const row = await withFixtureTenant(database(), { stackId }, async (tx) => {
      const rows = await tx.execute<{
        queue: number;
        entities: number;
        relationships: number;
      }>(sql`
        select
          (select count(*)::int from backfeed_queue where stack_id = ${stackId}) as queue,
          (select count(*)::int from ontology_entities where stack_id = ${stackId}) as entities,
          (select count(*)::int from ontology_relationships where stack_id = ${stackId}) as relationships
      `);
      const counted = rows[0];
      if (counted === undefined) throw new Error("count query returned no row");
      return counted;
    });
    totals.queue += row.queue;
    totals.entities += row.entities;
    totals.relationships += row.relationships;
  }
  return totals;
}

export function deps(apiKey = ""): BackfeedRouterDependencies {
  return {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(
      parseConfig(apiKey === "" ? {} : { AKS_API_KEY: apiKey }),
    ),
  };
}

export function buildApp(apiKey = ""): Express {
  const app = express();
  app.use(express.json());
  app.use("/aks/v1/backfeed", createBackfeedRouter(deps(apiKey)));
  return app;
}

export function buildFullApp(): Express {
  return createApp(deps());
}

export function expectOracleTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`expected a timestamp string, received ${typeof value}`);
  }
  expect(value).toHaveLength(27);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}

export function asRecord(body: unknown): Record<string, unknown> {
  expect(typeof body).toBe("object");
  expect(body).not.toBeNull();
  expect(Array.isArray(body)).toBe(false);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object response");
  }
  return Object.fromEntries(Object.entries(body));
}

export function asRecords(body: unknown): Record<string, unknown>[] {
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) {
    throw new Error("expected a JSON array response");
  }
  return body.map((item: unknown) => asRecord(item));
}

export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

afterAll(async () => {
  await deleteFixtureRows();
  // Cleanup is a contract of this suite: nothing prefixed may survive it.
  expect(await counts()).toEqual({
    stacks: 0,
    queue: 0,
    entities: 0,
    relationships: 0,
  });
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
