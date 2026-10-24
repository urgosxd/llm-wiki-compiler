/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-harness.ts
 * @description Shared pool setup, fixtures and app builder for the split `routes/stacks-*` test files.
 *
 * The `vi.hoisted` provider configuration stays in each test file.
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

import { createStacksRouter } from "./stacks.js";
import type { StacksRouterDependencies } from "./stacks.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `stacks-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix}. The
 * files run in parallel against one database and the cleanup deletes by prefix,
 * so a shared prefix would let one file delete another's fixtures mid-test.
 */
let domainPrefix = "t07-stacks-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `t07-stacks-${suffix}-`;
}

/**
 * The current domain prefix.
 *
 * Read at call time by the fixtures below; a describe body that builds its own
 * domain must call it rather than capture a constant, or it would bind the
 * default before {@link useDomainPrefix} ran.
 */
export function currentDomainPrefix(): string {
  return domainPrefix;
}

/**
 * The response keys every Stack row carries, in order.
 *
 * The first nine are the Python oracle's, unchanged. `ontology` is appended last
 * because that is also where `STACK_COLUMNS` selects it: an addition to the end
 * of a response is a different, smaller contract change than a reshuffle, and one
 * order is not two that can drift.
 */
export const RESPONSE_KEYS = [
  "id",
  "name",
  "domain",
  "description",
  "scope",
  "compilation_strategy",
  "synthesize_descriptions",
  "created_at",
  "updated_at",
  "ontology",
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
  console.warn(`[stacks.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export async function deleteFixtureRows(): Promise<void> {
  await database().execute(
    sql`delete from stacks where domain like ${`${domainPrefix}%`}`,
  );
}

export async function countFixtureRows(): Promise<number> {
  const rows = await database().execute<{ total: number }>(
    sql`select count(*)::int as total from stacks where domain like ${`${domainPrefix}%`}`,
  );
  return rows[0]?.total ?? -1;
}

export function deps(apiKey = ""): StacksRouterDependencies {
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
  app.use("/stacks", createStacksRouter(deps(apiKey)));
  return app;
}

export function createBody(
  payloadDomain: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: "T0.7 Stack", domain: payloadDomain, ...overrides };
}

export function expectOracleTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`expected a timestamp string, received ${typeof value}`);
  }
  expect(value).toHaveLength(27);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}

export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

export function asRows(body: unknown): Record<string, unknown>[] {
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) {
    throw new Error("expected a JSON array response");
  }
  return body.map((item: unknown) => {
    expect(typeof item).toBe("object");
    if (typeof item !== "object" || item === null) {
      throw new Error("expected every array element to be an object");
    }
    return Object.fromEntries(Object.entries(item));
  });
}

afterAll(async () => {
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

afterAll(async () => {
  if (state.skipReason !== false) {
    return;
  }
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);
});

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
