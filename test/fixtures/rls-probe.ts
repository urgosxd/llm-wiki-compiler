/**
 * @file test/fixtures/rls-probe.ts
 * @description Ask the DATABASE what it enforces, not what a query author remembered
 * to write.
 *
 * ## Why this cannot be done with the harness's own connection
 *
 * `test/fixtures/kg-postgres.ts` connects as `aks`, which is a SUPERUSER with
 * BYPASSRLS. Under that role every tenant policy is INERT, so an isolation assertion
 * run through it passes for the wrong reason -- the trap `kg-runtime-rls-trap.test.ts`
 * pins as measured fact.
 *
 * The probe therefore drops to `llmwiki_app`, the non-superuser role production uses,
 * with a transaction-scoped `set local role`. If that role is absent the suite must
 * skip loudly instead of claiming a guarantee it cannot test.
 *
 * ## Why this is shared
 *
 * The identical probe existed in two suites; only the counted query differed. Fallow
 * flagged the copies, and more importantly a second copy of a security probe is a
 * second thing that can drift from the one that was measured.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";

/** The role the application is meant to run as, once the DSN is switched. */
export const APP_ROLE = "llmwiki_app";

/**
 * Is the app role present in this database?
 *
 * Without it the only available role is the superuser, every policy is inert, and
 * every isolation assertion would pass vacuously.
 *
 * @param db - Database handle to ask.
 * @returns True when `llmwiki_app` exists.
 */
export async function appRoleExists(db: Database): Promise<boolean> {
  try {
    const rows = await db.execute<{ n: number }>(
      `select count(*)::int as n from pg_roles where rolname = '${APP_ROLE}'`,
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Run `count` as the app role, optionally bound to a Stack.
 *
 * The caller supplies the query so the probe can be about ANY table; what this
 * function owns is the role drop, the unbind, and the optional rebind -- the three
 * steps that are easy to get subtly wrong and must not vary per suite.
 *
 * The callback receives the TRANSACTION handle, never the pooled one: running the
 * count through the pool would execute it on a different connection, outside the
 * `set local role`, and the probe would silently answer from the superuser session
 * -- which is exactly the vacuous pass it exists to prevent.
 *
 * @param db - Database handle to open the probe transaction on.
 * @param boundStackId - Stack to bind, or `null` for an unbound session.
 * @param count - Statement answering how many rows the bound session can see.
 * @returns What `count` returned inside the app-role transaction.
 */
export async function countAsAppRole(
  db: Database,
  boundStackId: string | null,
  count: (tx: Database) => Promise<number>,
): Promise<number> {
  return db.transaction(async (tx) => {
    // `SET LOCAL ROLE` takes no bind parameters, so it is raw SQL; the role name is
    // a constant above, never caller input.
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(sql.raw("reset app.stack_id"));
    // A rebind AFTER the drop is what makes the difference between "the policy saw
    // no tenant" and "the policy saw this tenant" measurable.
    if (boundStackId !== null) {
      await tx.execute(sql`select set_config('app.stack_id', ${boundStackId}, true)`);
    }
    return count(tx as unknown as Database);
  });
}

/**
 * Are the given `wiki` schema tables all present?
 *
 * ## Why the question is about PRESENCE, never about a count
 *
 * An earlier version of this probe counted every table in the `wiki` schema and
 * compared the total. Adding one unrelated table silently flipped the guard to false
 * and disabled a whole suite -- and a skip is SILENT, so nothing pointed at the cause.
 * Asking for the specific tables a suite uses cannot be invalidated by unrelated work.
 *
 * @param db - Database handle to ask.
 * @param tables - Table names the suite cannot run without.
 * @returns True when every named table exists.
 */
export async function wikiTablesPresent(
  db: Database,
  tables: readonly string[],
): Promise<boolean> {
  try {
    const rows = await db.execute<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'wiki' and table_name in (${tables.map((t) => `'${t}'`).join(", ")})`,
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) === tables.length;
  } catch {
    return false;
  }
}
