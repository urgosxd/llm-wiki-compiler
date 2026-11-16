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
import type { DatabaseHandle } from "@repo/foundation";

import { createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import { DEFAULT_STACK_DOMAIN } from "../../../packages/wiki/src/dimensions/stack-selection.js";
import { resolveStackForCommand } from "../../../packages/wiki/src/services/stacks/resolve-stack.js";
import { isolatedCases } from "../../fixtures/stack-rollback.js";

const harness = await createKgPostgresHarness("resolve-stack");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/**
 * Ids of every row claiming the default domain, as they stand on `tx`.
 *
 * @param tx - Handle to read through.
 * @returns The matching Stack ids.
 */
async function defaultStackIds(tx: DatabaseHandle): Promise<readonly string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from stacks where domain = ${DEFAULT_STACK_DOMAIN}`,
  );
  return rows.map((row) => row.id);
}

/** The isolated case runner: a free default domain, and everything rolled back. */
const isolated = isolatedCases(db);

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
