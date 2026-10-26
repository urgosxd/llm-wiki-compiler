/**
 * @file test/dimensions/compile-config-isolation.test.ts
 * @description Does `wiki.compile_config` isolate by Stack, or only carry the id?
 *
 * This does NOT exercise the store's own reads: those carry an explicit
 * `where stack_id = ...` and would pass whether or not RLS works. It issues a RAW
 * query with NO stack predicate as `llmwiki_app` and asks what the database alone
 * enforces — following `wiki-stack-isolation.test.ts`.
 *
 * The role switch is load-bearing: the shared pool connects as `aks`, which is
 * SUPERUSER **with BYPASSRLS**, so every policy is inert from there. A test that
 * forgets `set local role` passes vacuously and proves the opposite of its claim.
 */

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { writeCompileConfig } from "../../src/dimensions/wiki/compile-config-store.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

const stackA = await createKgPostgresHarness("cfg-iso-a");
const stackB = await createKgPostgresHarness("cfg-iso-b");

/** The role the application is meant to run as, once the DSN is switched. */
const APP_ROLE = "llmwiki_app";

/** A frozen slug unique to this file, so a probe cannot collide with other suites. */
const SECRET_SLUG = "cfg-isolation-secret-slug";

const appRolePresent = await (async (): Promise<boolean> => {
  if (!stackA.reachable) return false;
  try {
    const rows = await stackA.db.execute<{ n: number }>(
      `select count(*)::int as n from pg_roles where rolname = '${APP_ROLE}'`,
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await stackA.cleanup();
  await stackB.cleanup();
});

/**
 * Count rows mentioning this file's secret slug, with NO stack predicate.
 *
 * @param db - Database handle to run on.
 * @param boundStackId - Stack to bind, or `null` for an unbound session.
 * @returns How many rows the statement could see.
 */
async function countSecretAsApp(db: Database, boundStackId: string | null): Promise<number> {
  return db.transaction(async (tx) => {
    // `SET LOCAL ROLE` takes no bind parameters, so it is raw SQL; the role name is
    // a constant above, never caller input.
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(sql.raw("reset app.stack_id"));
    if (boundStackId !== null) {
      await tx.execute(sql`select set_config('app.stack_id', ${boundStackId}, true)`);
    }
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from wiki.compile_config where ${SECRET_SLUG} = any(frozen_slugs)`,
    );
    return rows[0]?.n ?? 0;
  });
}

describe("compile_config isolates by Stack", () => {
  it.skipIf(!appRolePresent)("keeps one Stack's config invisible to a differently-scoped read", async () => {
    await writeCompileConfig(stackA.db, stackA.stackId, {
      frozenSlugs: [SECRET_SLUG],
      frozenEntities: [],
      promptModifiers: "iso",
    });

    // The row really exists — asserted as `aks`, which bypasses RLS. Without this,
    // every zero below could equally mean "the write never happened".
    const asSuperuser = await stackA.db.execute<{ n: number }>(
      sql`select count(*)::int as n from wiki.compile_config where ${SECRET_SLUG} = any(frozen_slugs)`,
    );
    expect(asSuperuser[0]?.n).toBe(1);

    // Bound to its own Stack, the app role sees it.
    expect(await countSecretAsApp(stackB.db, stackA.stackId)).toBe(1);

    // Bound to a DIFFERENT Stack, it does not — this is the assertion that matters.
    expect(await countSecretAsApp(stackB.db, stackB.stackId)).toBe(0);

    // Unbound fails closed rather than showing everything.
    expect(await countSecretAsApp(stackB.db, null)).toBe(0);
  });
});
