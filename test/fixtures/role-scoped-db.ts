/**
 * @file test/fixtures/role-scoped-db.ts
 * @description A database handle whose EVERY transaction runs as the app role.
 *
 * ## Why the existing `asAppRole` helper cannot reach these functions
 *
 * `asAppRole` opens one transaction, drops to `llmwiki_app` inside it, and runs a
 * caller-supplied query. That proves a STATEMENT is policied, but it cannot test a
 * FUNCTION that opens its own transaction: the function calls `db.transaction(...)`
 * on the handle it was given, which checks out a different pooled connection, and
 * `SET LOCAL ROLE` is transaction-scoped, so the role is gone before the function's
 * statement runs.
 *
 * That gap is exactly what hid the four binding defects: each function bound the
 * tenant outside its own transaction, and no test could observe it because the
 * harness connects as a BYPASSRLS superuser.
 *
 * ## What this handle does instead
 *
 * Every `transaction()` is wrapped so the role is set INSIDE it, before the
 * callback runs. A function under test therefore opens its own transaction, gets
 * the app role for free, and its `bindStack(tx, ...)` lands in the same scope as
 * its read -- the property the fix depends on.
 *
 * A bare `execute()` is routed through a transaction too, because a statement
 * outside any transaction cannot carry a role at all.
 */

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";

import { APP_ROLE } from "./rls-probe.js";

/** The minimal shape this fixture needs from a database handle. */
type AnyDb = DatabaseHandle & {
  execute: (query: unknown) => Promise<unknown>;
  transaction: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
};

/**
 * Wrap a handle so every transaction and statement runs as {@link APP_ROLE}.
 *
 * @param db - Real handle, connected as the superuser harness role.
 * @returns A handle that behaves like `db` but every scope is policied.
 */
export function roleScopedDb(db: DatabaseHandle): DatabaseHandle {
  const wrapped = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      (db as unknown as AnyDb).transaction(async (tx: unknown) => {
        await (tx as AnyDb).execute(sql.raw(`set local role ${APP_ROLE}`));
        // A transaction-scoped binding survives only if it is set here, after the
        // role drop and inside the same scope the callback will use.
        return work(tx);
      }),
    execute: async (query: unknown) =>
      (db as unknown as AnyDb).transaction(async (tx: unknown) => {
        await (tx as AnyDb).execute(sql.raw(`set local role ${APP_ROLE}`));
        return (tx as AnyDb).execute(query);
      }),
  };
  return wrapped as unknown as DatabaseHandle;
}
