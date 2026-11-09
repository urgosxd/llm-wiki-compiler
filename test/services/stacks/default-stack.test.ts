/**
 * @file test/services/stacks/default-stack.test.ts
 * @description The one Stack a workspace gets when it configured none.
 *
 * ## Why every case runs inside a transaction that is rolled back
 *
 * The default Stack is identified by its `domain`, and `stacks.domain` is globally
 * unique. So "does the first use create exactly one row, and does the second use
 * reuse it" has no per-suite slice to own the way `createKgPostgresHarness` owns a
 * random Stack: two concurrent runs, or one leftover row, would decide these
 * assertions for us.
 *
 * Each case therefore deletes the `default` domain row, runs, and rolls the whole
 * transaction back. The delete makes the case independent of leftover state, and
 * the rollback is what makes it safe — nothing this file does reaches the database,
 * in either direction.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";

import { createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import {
  DEFAULT_STACK_DOMAIN,
  DEFAULT_STACK_NAME,
} from "../../../src/dimensions/stack-selection.js";
import { ensureDefaultStack } from "../../../src/services/stacks/default-stack.js";

/** One row at the default domain, as the cases read it back. */
interface DefaultRow {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly description: string | null;
}

const harness = await createKgPostgresHarness("default-stack");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/** Thrown to abandon a case's transaction; it never surfaces from a case. */
class Rollback extends Error {}

/**
 * The `default` domain rows as they stand on `tx`, whatever their name.
 *
 * @param tx - Handle to read through.
 * @returns Every row claiming the default domain.
 */
async function defaultRows(tx: DatabaseHandle): Promise<readonly DefaultRow[]> {
  return tx.execute<DefaultRow>(sql`
    select id, name, domain, description from stacks where domain = ${DEFAULT_STACK_DOMAIN}
  `);
}

/**
 * Run `body` on a handle where the default domain is free, and roll it all back.
 *
 * @param body - Work to run against the isolated handle.
 * @returns What `body` returned.
 */
async function isolated<T>(body: (tx: DatabaseHandle) => Promise<T>): Promise<T> {
  let produced: T | undefined;
  await db
    .transaction(async (tx) => {
      await tx.execute(sql`delete from stacks where domain = ${DEFAULT_STACK_DOMAIN}`);
      produced = await body(tx as unknown as DatabaseHandle);
      throw new Rollback("abandon the case's transaction");
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return produced as T;
}

describe.skipIf(!reachable)("ensureDefaultStack", () => {
  it("creates one Stack at the default domain and name", async () => {
    const observed = await isolated(async (tx) => {
      const stackId = await ensureDefaultStack(tx);
      return { stackId, rows: await defaultRows(tx) };
    });

    expect(observed.rows).toHaveLength(1);
    expect(observed.rows[0]?.domain).toBe(DEFAULT_STACK_DOMAIN);
    expect(observed.rows[0]?.name).toBe(DEFAULT_STACK_NAME);
    expect(observed.rows[0]?.description).toBeNull();
    expect(observed.rows[0]?.id).toBe(observed.stackId);
  });

  it("returns the same Stack on a second call, still one row", async () => {
    const observed = await isolated(async (tx) => {
      const first = await ensureDefaultStack(tx);
      const second = await ensureDefaultStack(tx);
      return { first, second, rows: await defaultRows(tx) };
    });

    expect(observed.second).toBe(observed.first);
    expect(observed.rows).toHaveLength(1);
  });

  it("does not overwrite a Stack that already owns the default domain", async () => {
    const observed = await isolated(async (tx) => {
      const existing = randomUUID();
      await tx.execute(sql`
        insert into stacks (id, name, domain)
        values (${existing}, ${"Pre-existing"}, ${DEFAULT_STACK_DOMAIN})
      `);
      return { existing, returned: await ensureDefaultStack(tx), rows: await defaultRows(tx) };
    });

    expect(observed.returned).toBe(observed.existing);
    expect(observed.rows).toHaveLength(1);
    expect(observed.rows[0]?.name).toBe("Pre-existing");
  });
});
