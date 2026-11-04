/**
 * @file test/services/stacks/resolve-stack.test.ts
 * @description The Stack a command works on, resolved from a selection and, when it
 * is the default, materialized.
 *
 * ## What these cases pin
 *
 * Three rules, and the third is the one a careless implementation breaks: an
 * explicitly configured Stack is used AS GIVEN (no provisioning, no second answer),
 * an unconfigured checkout falls back to the one default Stack, and resolving twice
 * reaches the SAME Stack instead of creating a second one.
 *
 * ## Why every case runs inside a transaction that is rolled back
 *
 * The default Stack is identified by its `domain`, and `stacks.domain` is globally
 * unique. "does the second call reuse the row" therefore has no per-suite slice to
 * own the way {@link createKgPostgresHarness} owns a random Stack: a leftover row, or
 * a concurrent suite, would decide the assertion instead of the code. Each case
 * deletes the `default` domain row, runs, and rolls everything back -- so nothing
 * this file does reaches the database in either direction.
 */

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";

import { createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import { DEFAULT_STACK_DOMAIN } from "../../../src/dimensions/stack-selection.js";
import { resolveStackForCommand } from "../../../src/services/stacks/resolve-stack.js";

const harness = await createKgPostgresHarness("resolve-stack");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/** Thrown to abandon a case's transaction; it never surfaces from a case. */
class DiscardCase extends Error {}

/**
 * Ids of every row claiming the default domain, as they stand on `tx`.
 *
 * @param tx - Handle to read through.
 * @returns The matching Stack ids.
 */
async function defaultStackIds(tx: Database): Promise<readonly string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from stacks where domain = ${DEFAULT_STACK_DOMAIN}`,
  );
  return rows.map((row) => row.id);
}

/**
 * Run `body` on a handle where the default domain is free, then discard everything.
 *
 * The delete makes the case independent of a row an earlier run or a sibling suite
 * left behind -- `default-stack.test.ts` commits nothing either, but nothing stops
 * the ingest path from having materialized the default Stack for real (an ingest
 * opens its own connection, so it cannot be wrapped here).
 *
 * @param body - Work to run against the isolated handle.
 * @returns What `body` returned.
 */
async function isolated<T>(body: (tx: Database) => Promise<T>): Promise<T> {
  const observed: { value?: T } = {};
  const run = async (tx: Database): Promise<void> => {
    await tx.execute(sql`delete from stacks where domain = ${DEFAULT_STACK_DOMAIN}`);
    observed.value = await body(tx);
    throw new DiscardCase("roll the case's work back");
  };
  await db.transaction((tx) => run(tx as unknown as Database)).catch((error: unknown) => {
    if (error instanceof DiscardCase) return;
    throw error;
  });
  return observed.value as T;
}

describe.skipIf(!reachable)("resolveStackForCommand", () => {
  it("falls back to the default Stack when nothing is configured", async () => {
    const observed = await isolated(async (tx) => {
      const stackId = await resolveStackForCommand(tx, {});
      return { stackId, rows: await defaultStackIds(tx) };
    });

    expect(observed.stackId).toBeDefined();
    expect(observed.rows).toEqual([observed.stackId]);
  });

  it("returns a configured Stack as given, provisioning no default", async () => {
    const observed = await isolated(async (tx) => {
      const stackId = await resolveStackForCommand(tx, { AKS_STACK_ID: harness.stackId });
      return { stackId, rows: await defaultStackIds(tx) };
    });

    expect(observed.stackId).toBe(harness.stackId);
    expect(observed.rows).toEqual([]);
  });

  it("resolves the same default twice, leaving exactly one row", async () => {
    const observed = await isolated(async (tx) => {
      const first = await resolveStackForCommand(tx, {});
      const second = await resolveStackForCommand(tx, {});
      return { first, second, rows: await defaultStackIds(tx) };
    });

    expect(observed.second).toBe(observed.first);
    expect(observed.rows).toEqual([observed.first]);
  });
});
