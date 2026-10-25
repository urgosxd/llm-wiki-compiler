/**
 * Tenant binding for test fixtures that write rows directly.
 *
 * ## Why fixtures need this at all
 *
 * Every tenant-scoped table carries an RLS policy, and since
 * `db/migration_rls_write_policies.sql` those policies validate writes as well as
 * reads. A fixture that does a bare `insert into stacks ...` therefore fails as soon
 * as the suite runs against the unprivileged role:
 *
 *   new row violates row-level security policy for table "stacks"
 *
 * Production paths bind the tenant from the caller's own reference (see
 * `bindCallerStack` and `findDocument`). Fixtures have the same information — they
 * generate the ids and domains themselves — so they must do the same.
 *
 * ## The transaction requirement
 *
 * `set_config(..., true)` is TRANSACTION-local. On a pooled client two bare
 * `database().execute()` calls can land on different connections, and the binding is
 * gone before the INSERT runs. A binding is therefore only meaningful inside a
 * transaction shared with the write it protects, which is what `withFixtureTenant`
 * guarantees by construction: the callback receives the same `tx`.
 *
 * No-op while the connection uses a role that bypasses RLS (`aks`), which is why
 * these fixtures kept passing before the role was switched.
 */

import { sql } from "drizzle-orm";

import type { Database } from "../db.js";

/**
 * Runs `write` in a transaction that has the tenant already bound.
 *
 * @param db - Pooled database handle.
 * @param tenant - The Stack the fixture is about to write. `stackId` binds
 *   `app.stack_id`; `domain` binds `app.stack_domain`. Supply `domain` for rows being
 *   INSERTed into `stacks`, and `stackId` for rows that reference an existing Stack.
 * @param write - Callback receiving the bound transaction.
 * @returns Whatever `write` returns.
 */
export async function withFixtureTenant<T>(
  db: Database,
  tenant: { readonly stackId?: string; readonly domain?: string },
  write: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (tenant.stackId !== undefined && tenant.stackId !== "") {
      await tx.execute(sql`select set_config('app.stack_id', ${tenant.stackId}, true)`);
    }
    if (tenant.domain !== undefined && tenant.domain !== "") {
      await tx.execute(sql`select set_config('app.stack_domain', ${tenant.domain}, true)`);
    }
    return write(tx);
  });
}
