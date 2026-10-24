import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import { apiError } from "../errors.js";
import type { ApiError } from "../errors.js";

/**
 * Resolve a Stack from either a UUID or a domain slug.
 *
 * TypeScript port of `app/core/stack_resolver.py`. Every AKS endpoint accepts
 * both references as alternatives — clients call `?stack_id=<uuid>` or
 * `?domain=<slug>` — so the lookup and its error contract live here instead of
 * being repeated five times in the router.
 *
 * ## Three distinct failures, all measured on the oracle
 *
 * - **Neither reference supplied** -> `422` with a *plain-string* `detail`, not
 *   the 422 error array. FastAPI's `HTTPException(422, "...")` renders
 *   `{"detail": "<message>"}`; only `RequestValidationError` renders an array.
 *   Reproducing the wrong one of the two shapes is a visible contract break, so
 *   this returns an {@link ApiError} rather than a `ValidationFailure`.
 * - **`stack_id` supplied but unknown** -> `404`, naming the canonical lowercase
 *   UUID (the query-parameter validator has already normalized it).
 * - **`domain` supplied but unknown** -> `404`, naming the domain slug.
 *
 * An *empty* `domain=` counts as absent: Python's guard is a truthiness test
 * (`if not stack_id and not domain`), and `""` is falsy. Measured:
 * `GET /aks/v1/entities?domain=` answers 422, while
 * `?domain=&stack_id=<valid uuid>` answers 200 — because `stack_id` alone then
 * satisfies the guard.
 *
 * When both are supplied `stack_id` wins, because the Python function branches
 * on it first; the `domain` value is never even queried.
 */

/** Columns the resolver selects, in the Python function's order. */
export const STACK_COLUMNS =
  "id, name, domain, description, scope, compilation_strategy, created_at, updated_at";

/**
 * A resolved `stacks` row.
 *
 * Timestamps stay `string`: `db.ts` registers a `timestamptz` parser that
 * normalizes Postgres text into the exact form Pydantic emits, and converting to
 * `Date` here would destroy microseconds (see `odd/findings/timestamp-precision.md`).
 * `compilation_strategy` is nullable in SQL even though `StackCreate` defaults
 * it, so a row inserted by hand can carry `null`.
 */
export type StackRow = {
  id: string;
  name: string;
  domain: string;
  description: string | null;
  scope: string;
  compilation_strategy: string | null;
  created_at: string;
  updated_at: string;
};


/**
 * Establishment of tenant context for the rest of one transaction.
 *
 * ## Why the GUC and not a per-query parameter
 *
 * Row-level security reads `current_setting('app.stack_id')`, so the tenant must
 * be established ONCE per transaction, before any tenanted query runs. Passing the
 * stack id to every statement instead would leave RLS with nothing to compare
 * against and push the whole burden back onto each query's author — which is
 * exactly the failure the 15 unfiltered statements already demonstrate.
 *
 * ## Why there are TWO settings
 *
 * Resolving a stack is itself a read of `stacks`, but the caller may identify the
 * stack by `domain` rather than by id — and at that moment `app.stack_id` is not
 * known yet. A policy that accepted only `id = current_setting('app.stack_id')`
 * would make domain-based resolution impossible, so `app.stack_domain` carries
 * the other half of the caller's claim. `stacks` policies therefore accept either
 * match; every OTHER table accepts only the id, because by the time content is
 * touched the stack is resolved.
 *
 * The suffix `,true` makes the setting return NULL instead of raising when it was
 * never set, so a missing binding fails CLOSED (matches nothing) rather than
 * erroring in a way a caller might be tempted to swallow.
 *
 * @param tx - Transaction that will carry the tenanted queries.
 * @param stackId - Resolved stack UUID.
 * @param stackDomain - Domain the caller used, when resolution used it.
 */
export async function bindTenant(
  tx: Database,
  stackId: string,
  stackDomain: string | null,
): Promise<void> {
  // `set_config` with `is_local = true` scopes both settings to this transaction,
  // which is the SQL form of SET LOCAL and accepts parameters (SET does not).
  await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
  if (stackDomain !== null && stackDomain !== "") {
    await tx.execute(sql`select set_config('app.stack_domain', ${stackDomain}, true)`);
  }
}

/** A resolved Stack, or the error to answer with instead. */
export type StackResolution =
  | { readonly ok: true; readonly stack: StackRow }
  | { readonly ok: false; readonly error: ApiError };

/**
 * Looks up a Stack by id or domain.
 *
 * @param stackId canonical UUID text, or `null` when the parameter was absent.
 *   Order matters: pass the *validated* value, because FastAPI has already
 *   rejected a malformed UUID with a 422 before the handler runs.
 * @param domain raw slug, or `null` when absent.
 */
export async function resolveStack(
  tx: Database,
  stackId: string | null,
  domain: string | null,
): Promise<StackResolution> {
  const hasDomain = domain !== null && domain !== "";

  if (stackId === null && !hasDomain) {
    return {
      ok: false,
      error: apiError(422, "Either stack_id (UUID) or domain (slug) must be provided"),
    };
  }

  const rows =
    stackId !== null
      ? await tx.execute<StackRow>(sql`
          select ${sql.raw(STACK_COLUMNS)}
          from stacks
          where id = ${stackId}
        `)
      : await tx.execute<StackRow>(sql`
          select ${sql.raw(STACK_COLUMNS)}
          from stacks
          where domain = ${domain}
        `);

  const stack = rows[0];
  if (stack === undefined) {
    const ident = stackId !== null ? stackId : domain;
    return { ok: false, error: apiError(404, `Stack '${String(ident)}' not found`) };
  }

  await bindTenant(tx, stack.id, domain);

  return { ok: true, stack };
}
