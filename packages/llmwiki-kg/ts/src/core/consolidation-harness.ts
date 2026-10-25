/**
 * @file packages/llmwiki-kg/ts/src/core/consolidation-harness.ts
 * @description Shared pool setup, fixtures and row readers for the split
 * `consolidation-*` test files.
 *
 * This was the prelude of one large `consolidation.test.ts`. It is not a test
 * file, so the runner does not collect it; each split file imports what it needs.
 */

import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, expect } from "vitest";

import {
  createClient,
  createDatabase,
  createTransactionRunner,
} from "../db.js";
import type { Database, TransactionRunner } from "../db.js";
import { FixtureStacks } from "../routes/fixture-tenant.js";
import type {
  BackfeedEntityProposalDto,
  BackfeedRelationshipProposalDto,
} from "../dto.js";

export const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Namespace for this suite's fixture rows.
 *
 * The consolidated suite was split across several files that run in PARALLEL
 * against one shared database. A single shared prefix made each file's cleanup
 * delete its siblings' rows, which surfaced as a different test failing on
 * different runs. Each split file therefore claims its own suffix through
 * {@link useDomainPrefix}, and cleanup stays inside that namespace.
 *
 * Suffixes must not be prefixes of one another: cleanup matches with `LIKE`,
 * so `flag` would also match `flag-validation`'s rows.
 */
let DOMAIN_PREFIX = "w1bf-consolidation-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  DOMAIN_PREFIX = `w1bf-consolidation-${suffix}-`;
}

/** The current domain prefix. */
export function currentDomainPrefix(): string {
  return DOMAIN_PREFIX;
}

export const state: {
  client?: Sql;
  database?: Database;
  runner?: TransactionRunner;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    const database = createDatabase(candidate);
    state.client = candidate;
    state.database = database;
    state.runner = createTransactionRunner(database);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

if (state.skipReason !== false) {
  console.warn(
    `[consolidation.test] skipping integration tests — ${state.skipReason}`,
  );
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export function runner(): TransactionRunner {
  if (state.runner === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.runner;
}

/** Fixture Stacks created by the consolidation suites. */
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

export async function countFixtureEntities(): Promise<number> {
  // Summed per tracked Stack: a count across several Stacks has no single tenant to
  // bind, so the old prefix query cannot see them under RLS.
  return fixtureStacks.sum(database(), async (tx, stackId) => {
    const rows = await tx.execute<{ total: number }>(
      sql`select count(*)::int as total from ontology_entities where stack_id = ${stackId}`,
    );
    return rows[0]?.total ?? -1;
  });
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureEntities()).toBe(0);
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

export type EntityRow = {
  name: string;
  type: string;
  description: string | null;
  confidence: number;
  verified: boolean;
  source_kind: string | null;
  pipeline: string | null;
  extracted_by_model: string | null;
  properties: unknown;
};

export function entity(
  name: string,
  overrides: Partial<BackfeedEntityProposalDto> = {},
): BackfeedEntityProposalDto {
  return {
    name,
    type: "concept",
    description: null,
    confidence: 0.7,
    properties: {},
    ...overrides,
  };
}

export function relationship(
  from: string,
  to: string,
  overrides: Partial<BackfeedRelationshipProposalDto> = {},
): BackfeedRelationshipProposalDto {
  return {
    from_entity: from,
    to_entity: to,
    type: "relates_to",
    description: null,
    confidence: 0.7,
    ...overrides,
  };
}

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
