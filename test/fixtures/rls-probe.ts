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
 * The probe therefore drops to `llmwiki_app`, the non-superuser role production is
 * MEANT to run as once the DSN is switched, with a transaction-scoped
 * `set local role`. If that role is absent the suite must skip loudly instead of
 * claiming a guarantee it cannot test.
 *
 * ## What the probe measures is the FUTURE state, not the current one
 *
 * `llmwiki_app` is NOT the role production uses today. It has no `LOGIN`, inherits
 * from nothing, and no production code issues a `SET ROLE`, while the only role
 * that can actually connect (`aks`) is a BYPASSRLS superuser. So every policy on
 * the 22 `wiki` tables is currently INERT, and isolation rests entirely on the
 * explicit `where stack_id = ...` predicates in each query.
 *
 * Measured on this database as `aks`, with no predicate at all:
 *
 *   select count(*), count(distinct stack_id) from wiki.source_documents
 *   -> 32 rows across 8 Stacks
 *
 * Nothing in that result was stopped by row-level security. The guarantee is real
 * only once the deployment switches to a policied role, which is what the 22 tables
 * with `relforcerowsecurity = true` and the `grant ... to llmwiki_app` statements
 * exist to enable. Treating that apparatus as active today is the same mistake as
 * reading a mechanism's presence as its operation.
 *
 * ## Why this is shared
 *
 * The identical probe existed in two suites; only the counted query differed. Fallow
 * flagged the copies, and more importantly a second copy of a security probe is a
 * second thing that can drift from the one that was measured.
 *
 * ## Absent object versus absent database
 *
 * Every probe here answers a yes/no question, and a boolean is exactly the shape that
 * turns a missing database into a skip. Measured: with nothing listening, the `catch`
 * below returned `false`, `!appRolePresent` skipped `compile-config-isolation`, and the
 * suite reported GREEN while asserting nothing.
 *
 * So a failed probe is re-asked as a liveness question, and the two answers are kept
 * apart: the server not answering `select 1` is an UNOBTAINABLE database and throws the
 * actionable failure ({@link missingTestDatabase}); the server answering while the object
 * is absent stays `false`, which keeps the documented skip for a role a deployment has
 * not created yet. `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` restores the skip in both cases.
 */

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import { missingTestDatabase } from "./test-database-handoff.js";

/** The role the application is meant to run as, once the DSN is switched. */
export const APP_ROLE = "llmwiki_app";

/** A message from an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decide whether a failed probe means "absent" or "no database at all".
 *
 * @param db - DatabaseHandle handle whose probe failed.
 * @param context - Which probe failed, phrased for whoever reads the failure.
 * @param cause - The probe's own error.
 * @returns `false` when the server answered and the object is genuinely absent.
 * @throws When the server does not answer, unless the documented opt-out is set.
 */
async function absentOrUnreachable(
  db: DatabaseHandle,
  context: string,
  cause: unknown,
): Promise<boolean> {
  try {
    await db.execute("select 1");
  } catch (probeError) {
    const missing = missingTestDatabase(
      context,
      `the probe failed (${describe(cause)}), and a select 1 liveness probe then failed too ` +
        `(${describe(probeError)})`,
    );
    if (missing.error !== undefined) throw missing.error;
    console.warn(`${context}: every case in this file will be skipped.\n${missing.message}`);
    return false;
  }
  // The server answered, so the OBJECT is what is missing. That is the documented skip.
  return false;
}

/**
 * Is the app role present in this database?
 *
 * Without it the only available role is the superuser, every policy is inert, and
 * every isolation assertion would pass vacuously.
 *
 * @param db - DatabaseHandle handle to ask.
 * @returns True when `llmwiki_app` exists.
 * @throws When the database cannot be obtained at all, unless the opt-out is set.
 */
export async function appRoleExists(db: DatabaseHandle): Promise<boolean> {
  try {
    const rows = await db.execute<{ n: number }>(
      `select count(*)::int as n from pg_roles where rolname = '${APP_ROLE}'`,
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  } catch (error) {
    return absentOrUnreachable(db, "rls-probe: appRoleExists", error);
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
 * @param db - DatabaseHandle handle to open the probe transaction on.
 * @param boundStackId - Stack to bind, or `null` for an unbound session.
 * @param count - Statement answering how many rows the bound session can see.
 * @returns What `count` returned inside the app-role transaction.
 */
export async function countAsAppRole(
  db: DatabaseHandle,
  boundStackId: string | null,
  count: (tx: DatabaseHandle) => Promise<number>,
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
    return count(tx as unknown as DatabaseHandle);
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
 * @param db - DatabaseHandle handle to ask.
 * @param tables - Table names the suite cannot run without.
 * @returns True when every named table exists.
 * @throws When the database cannot be obtained at all, unless the opt-out is set.
 */
export async function wikiTablesPresent(
  db: DatabaseHandle,
  tables: readonly string[],
): Promise<boolean> {
  try {
    const rows = await db.execute<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'wiki' and table_name in (${tables.map((t) => `'${t}'`).join(", ")})`,
    );
    return ((rows[0] as { n: number } | undefined)?.n ?? 0) === tables.length;
  } catch (error) {
    return absentOrUnreachable(db, "rls-probe: wikiTablesPresent", error);
  }
}
