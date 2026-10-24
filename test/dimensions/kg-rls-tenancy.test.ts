/**
 * @file test/dimensions/kg-rls-tenancy.test.ts
 * @description Row-level security actually isolates tenants — proved against a
 * real database, and proved to depend on the APPLICATION ROLE, not just the schema.
 *
 * WHY THIS CANNOT BE MOCKED. RLS is enforced by Postgres. A mock asserts that a
 * query was issued; only the database can show that the policy filtered rows. The
 * whole point of this suite is the behaviour of `FORCE ROW LEVEL SECURITY` under a
 * specific role, which no unit test can reproduce.
 *
 * THE FINDING THAT SHAPES THIS FILE. `FORCE ROW LEVEL SECURITY` binds policies to
 * the TABLE OWNER. It does NOT override `SUPERUSER` or `BYPASSRLS`, which are role
 * attributes. Measured: with the repository's default `aks` role (both flags set)
 * a tenant-scoped session still saw every row, while a plain role saw only its own.
 * So the suite asserts BOTH directions — isolation under the app role, and the
 * reason it would be absent without one — rather than only the happy path.
 *
 * Skips loudly when the database or the role is absent, instead of passing vacuously.
 */
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

const harness = await createKgPostgresHarness("kg-rls");
const { db, reachable } = harness;

const STACK_A = "aaaa0000-0000-0000-0000-00000000000a";
const STACK_B = "bbbb0000-0000-0000-0000-00000000000b";

/**
 * Is the migration applied and does the app role exist?
 *
 * Both must hold for this suite to mean anything: policies without a
 * non-bypassrls role are inert, which is exactly the trap the migration header
 * documents.
 */
const provisioned = await (async (): Promise<boolean> => {
  if (!reachable) return false;
  try {
    const roles = await db.execute<{ n: number }>(
      "select count(*)::int as n from pg_roles where rolname = 'llmwiki_app'",
    );
    if ((roles[0] as { n: number }).n === 0) {
      console.warn("kg-rls: role llmwiki_app missing; run migration_rls_tenancy.sql");
      return false;
    }
    await db.execute(
      `insert into stacks (id, name, domain) values
         ('${STACK_A}', 'rls-a', 'rls-a'), ('${STACK_B}', 'rls-b', 'rls-b')
       on conflict (id) do nothing`,
    );
    await db.execute(
      `insert into ontology_entities (id, stack_id, name, type) values
         ('aaaa1111-0000-0000-0000-00000000000a', '${STACK_A}', 'OnlyA', 't'),
         ('bbbb1111-0000-0000-0000-00000000000b', '${STACK_B}', 'OnlyB', 't')
       on conflict (id) do nothing`,
    );
    return true;
  } catch (error) {
    console.warn(`kg-rls: could not provision — ${(error as Error).message}`);
    return false;
  }
})();

afterAll(async () => {
  if (provisioned) {
    await db.execute(`delete from stacks where id in ('${STACK_A}', '${STACK_B}')`).catch(() => undefined);
  }
  await harness.cleanup();
});

/** Names visible to the app role while bound to one stack. */
async function visibleAs(stackId: string | null): Promise<string[]> {
  return db.transaction(async (tx) => {
    // `SET LOCAL ROLE` takes no bind parameters, so it is issued as raw SQL; the
    // role name is a constant in this file, never caller input.
    await tx.execute(sql.raw("set local role llmwiki_app"));
    // Reset first: a pooled connection can carry a session-level GUC from an
    // earlier transaction, and then "no binding" would silently inherit one and
    // the fail-closed assertion would test nothing.
    await tx.execute(sql.raw("reset app.stack_id"));
    if (stackId !== null) await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<{ name: string }>(
      sql`select name from ontology_entities order by name`,
    );
    return rows.map((row) => row.name);
  });
}

describe("row-level security isolates tenants", () => {
  it.skipIf(!provisioned)("shows a tenant only its own entities", async () => {
    // Both entities exist; only the bound stack's is visible.
    expect(await visibleAs(STACK_A)).toContain("OnlyA");
    expect(await visibleAs(STACK_A)).not.toContain("OnlyB");
  }, 30_000);

  it.skipIf(!provisioned)("returns ZERO rows for another tenant's row", async () => {
    // The cross-tenant read the plan called for: a session scoped to A must not
    // reach B, even naming the row directly.
    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local role llmwiki_app"));
      await tx.execute(sql.raw("reset app.stack_id"));
      await tx.execute(sql`select set_config('app.stack_id', ${STACK_A}, true)`);
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ontology_entities where name = 'OnlyB'`,
      );
      return rows[0]?.n;
    });
    expect(seen).toBe(0);
  }, 30_000);

  it.skipIf(!provisioned)("fails CLOSED when no tenant binding is set", async () => {
    // A missing SET must match nothing, not everything: an unbound session is a
    // bug, and the safe direction is to see no data rather than all of it.
    expect(await visibleAs(null)).toHaveLength(0);
  }, 30_000);

  it.skipIf(!provisioned)("does not isolate under a SUPERUSER/BYPASSRLS role", async () => {
    // This asserts the DEFECT the migration header documents, so a future reader
    // cannot mistake "policies exist" for "policies apply". If this ever starts
    // failing, the database is configured better than assumed and the app-role
    // requirement can be reconsidered.
    const seen = await db.transaction(async (tx) => {
      // No `set role`: the pooled connection is `aks`, which bypasses RLS.
      await tx.execute(sql`select set_config('app.stack_id', ${STACK_A}, true)`);
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ontology_entities where name = 'OnlyB'`,
      );
      return rows[0]?.n;
    });
    expect(seen).toBe(1);
  }, 30_000);
});
