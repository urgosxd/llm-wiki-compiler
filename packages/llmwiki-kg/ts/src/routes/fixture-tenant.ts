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

/**
 * A set of fixture Stacks, cleaned and counted one at a time.
 *
 * ## Why a registry instead of the domain prefix
 *
 * Harnesses used to clean up with `delete by domain like '<prefix>%'`, and to count
 * the same way. Both are cross-tenant cursors: no single `app.stack_id` describes
 * them. Measured under RLS, such a delete bound to one domain removes that domain's
 * row and **silently leaves its siblings behind**, so it reports success while
 * cleaning part of what it selected.
 *
 * Collecting ids makes every statement single-tenant. The deletion needs one bound
 * `delete from stacks where id = $1` — the seven child tables follow through
 * `on delete cascade`, which was verified to fire under RLS, so no child delete is
 * needed. Counting loops the ids because a count across several Stacks has no single
 * tenant either; summing per-tenant answers gives callers the same number the old
 * prefix query did.
 */
export class FixtureStacks {
  readonly #ids = new Set<string>();

  /** Remembers a Stack so cleanup can target it. */
  add(stackId: string): void {
    this.#ids.add(stackId);
  }

  /** The tracked ids, oldest first. */
  ids(): readonly string[] {
    return [...this.#ids];
  }

  /**
   * Deletes every tracked Stack with its tenant bound, then forgets them.
   *
   * One transaction per Stack. The children go with the parent through the cascade,
   * so nothing else needs deleting — and the cascade cannot reach another tenant
   * because the parent row is already scoped by the policy.
   */
  async deleteAll(db: Database): Promise<void> {
    for (const stackId of this.#ids) {
      await withFixtureTenant(db, { stackId }, (tx) =>
        tx.execute(sql`delete from stacks where id = ${stackId}`),
      );
    }
    this.#ids.clear();
  }

  /**
   * Sums `count` over the tracked Stacks, one bound transaction at a time.
   *
   * `count` receives the transaction to query through, so the caller cannot
   * accidentally run its query unbound, and it already knows the Stack id.
   */
  async sum(
    db: Database,
    count: (tx: Database, stackId: string) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (const stackId of this.#ids) {
      total += await withFixtureTenant(db, { stackId }, (tx) => count(tx, stackId));
    }
    return total;
  }
}
