/**
 * @file test/dimensions/wiki-stack-isolation.test.ts
 * @description Does the wiki dimension actually ISOLATE by Stack, or does it
 * merely pass the id along and hope?
 *
 * ## The question this answers
 *
 * `store-dimension.ts` writes through `withTenant(db, stackId, ...)`, which runs
 * `set_config('app.stack_id', ..., true)` before the statement. `wiki.pages` also
 * carries a `tenant_isolation` policy. Two mechanisms, and until now neither had
 * been proven to do anything for the wiki: the KG side has
 * `kg-rls-tenancy.test.ts`, the wiki side had nothing.
 *
 * The dangerous alternative is that isolation comes from an explicit
 * `where stack_id = ...` that a future query might forget. So this file does not
 * test the dimension's own reads (which would pass either way). It tests a RAW
 * query with NO stack predicate, issued as the application role, and asks
 * whether RLS alone stops it.
 *
 * ## Why the role switch is load-bearing and easy to get wrong
 *
 * The shared pool connects as `aks`, which is SUPERUSER **with BYPASSRLS**. Under
 * that role every policy allows everything, so a test written the obvious way
 * passes vacuously and proves the opposite of what it claims. Everything here
 * therefore runs inside `set local role llmwiki_app`, following
 * `kg-rls-tenancy.test.ts`. Verified rather than assumed: the same statement that
 * returns 1 as `aks` returns 0 when bound to a different Stack as `llmwiki_app`.
 *
 * ## Why `reset app.stack_id` comes first
 *
 * A pooled connection can carry a session-level GUC from an earlier transaction.
 * Without the reset, a case that means "unbound" could silently inherit a binding
 * and assert nothing.
 */

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createWikiStoreDimension } from "../../src/dimensions/wiki/store-dimension.js";
import type { DimensionInput } from "../../src/dimensions/types.js";
import type { Database } from "llmwiki-kg";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const stackA = await createKgPostgresHarness("wiki-iso-a");
const stackB = await createKgPostgresHarness("wiki-iso-b");
const sourcesRoot = await mkdtemp(path.join(tmpdir(), "wiki-iso-"));

/** The role the application is meant to run as, once the DSN is switched. */
const APP_ROLE = "llmwiki_app";

/** A page title unique to this file, so a probe cannot collide with other suites. */
const SECRET_TITLE = "Isolation Secret Page";

/**
 * Is the app role present?
 *
 * Without it the only available role is `aks`, under which every policy is inert
 * and every isolation assertion would pass vacuously. So the suite skips loudly
 * rather than claiming a guarantee it cannot test.
 */
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

/** An ingest input with the fields the dimension reads. */
function inputOf(title: string, source: string): DimensionInput {
  const body = `body for ${title}`;
  return { source, title, document: `---\ntitle: ${title}\n---\n${body}`, body };
}

/**
 * Count this file's secret page with NO stack predicate, as the app role.
 *
 * The absence of a `where stack_id` is the point: it asks what the database
 * itself enforces, not what a query author remembered to write.
 *
 * @param db - Database handle to run on.
 * @param boundStackId - Stack to bind, or `null` for an unbound session.
 * @returns How many rows the statement could see.
 */
async function countSecretAsApp(db: Database, boundStackId: string | null): Promise<number> {
  return db.transaction(async (tx) => {
    // `SET LOCAL ROLE` takes no bind parameters, so it is raw SQL; the role name
    // is a constant above, never caller input.
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(sql.raw("reset app.stack_id"));
    if (boundStackId !== null) {
      await tx.execute(sql`select set_config('app.stack_id', ${boundStackId}, true)`);
    }
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from wiki.pages where title = ${SECRET_TITLE}`,
    );
    return rows[0]?.n ?? 0;
  });
}

describe("the wiki dimension isolates by Stack", () => {
  it.skipIf(!appRolePresent)("keeps a Stack's page invisible to a differently-scoped read", async () => {
    const dimensionA = createWikiStoreDimension({
      stackId: stackA.stackId,
      db: stackA.db,
      root: sourcesRoot,
    });
    const prepared = await dimensionA.prepare(inputOf(SECRET_TITLE, "src://iso-secret"));
    await dimensionA.commit(prepared);

    // The row really exists -- asserted as `aks`, which bypasses RLS. Without
    // this, every zero below could mean "the write never happened".
    const asSuperuser = await stackA.db.execute<{ n: number }>(
      sql`select count(*)::int as n from wiki.pages where title = ${SECRET_TITLE}`,
    );
    expect(asSuperuser[0]?.n).toBe(1);

    // Bound to its own Stack, the app role sees it.
    expect(await countSecretAsApp(stackA.db, stackA.stackId)).toBe(1);
    // Bound to a DIFFERENT Stack, the same predicate-free statement sees nothing.
    expect(await countSecretAsApp(stackA.db, stackB.stackId)).toBe(0);
  }, 30_000);

  it.skipIf(!appRolePresent)("fails CLOSED for an unbound session", async () => {
    // A missing binding must match nothing, not everything. This is the case
    // that shows the policy is what does the work: if isolation came from the
    // explicit predicate in `page-store.ts`, this statement has no predicate at
    // all and would report every page in the database.
    expect(await countSecretAsApp(stackA.db, null)).toBe(0);
  }, 30_000);

  it.skipIf(!appRolePresent)("isolates the dimension's OWN reads, not just raw SQL", async () => {
    // The read path a caller actually uses. `listStoredPages` binds its own
    // tenant, so a handle pointed at the wrong Stack must not return the page.
    const { listStoredPages } = await import("../../src/dimensions/wiki/page-store.js");
    const fromOwnStack = await listStoredPages(stackA.db, stackA.stackId, 200);
    expect(fromOwnStack.some((page) => page.title === SECRET_TITLE)).toBe(true);

    const fromOtherStack = await listStoredPages(stackB.db, stackB.stackId, 200);
    expect(fromOtherStack.some((page) => page.title === SECRET_TITLE)).toBe(false);
  }, 30_000);
});
