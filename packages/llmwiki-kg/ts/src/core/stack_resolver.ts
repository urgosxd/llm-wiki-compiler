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

/**
 * Columns the resolver selects, in the Python function's order.
 *
 * `ontology` is appended AFTER the oracle's columns rather than inserted among
 * them: the Python function this port reproduces does not know the column exists,
 * so keeping the original order first means a byte-for-byte comparison of the
 * oracle's projection still holds for the fields the oracle returns. Appending is
 * what lets the port carry a field the oracle never had without perturbing the
 * ones it did.
 */
export const STACK_COLUMNS =
  "id, name, domain, description, scope, compilation_strategy, created_at, updated_at, ontology";

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
  /**
   * The Stack's ontology declaration, or null.
   *
   * NULL IS MEANINGFUL: it is the oracle's behaviour — advertise the default type
   * hints and accept whatever the model emits. It is not "empty ontology", and a
   * caller must not coerce it to `{}`, which would silently switch the Stack into
   * enforcement mode.
   *
   * Typed `unknown` rather than a shape: this module resolves a ROW, and the
   * semantic shape is `core/ontology.ts`'s business. Validating here would put a
   * second parser in front of the one that already exists.
   */
  ontology?: unknown;
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

  await bootstrapTenant(tx, stackId, hasDomain ? domain : null);

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

/**
 * Set the tenant GUC from the caller's own identifier, before the lookup reads.
 *
 * ## Why this is needed at all
 *
 * `stacks` has a tenant policy, and the policy accepts an id OR a domain:
 *
 * ```sql
 * (id = current_setting('app.stack_id')::uuid)
 *   OR (domain = current_setting('app.stack_domain'))
 * ```
 *
 * The lookup below reads `stacks` BEFORE the row is known, so it ran with no GUC
 * set at all. That was invisible while the connection was `aks` -- a superuser that
 * owns the tables bypasses their own policies -- and it becomes a hard failure the
 * moment the connection is `llmwiki_app`: an unbound policy matches nothing, so
 * every `resolveStack` would answer 404 for a Stack that exists. Measured against
 * the live database: `set role llmwiki_app; select ... from stacks where id = <a
 * real id>` returns zero rows.
 *
 * The chicken-and-egg is only apparent. The caller already told us which Stack it
 * means -- that is what `stackId` and `domain` ARE -- so the identifier we would
 * read back is the identifier we were handed. Setting it first lets the policy
 * match the row it is about to be asked for, without granting any role elevated
 * read access and without a `security definer` function.
 *
 * ## What this does NOT weaken
 *
 * A caller cannot use this to read another tenant: the GUC is set to the value the
 * caller supplied, so the policy matches exactly that Stack and nothing else. An
 * unknown id matches no row and yields the same 404 as before. The binding is
 * still overwritten by {@link bindTenant} with the resolved values afterwards, so
 * the rest of the transaction runs on what the database confirmed rather than on
 * what the caller claimed.
 *
 * @param tx - Transaction that will carry the lookup.
 * @param stackId - Caller-supplied Stack UUID, or null.
 * @param domain - Caller-supplied domain slug, or null.
 */
async function bootstrapTenant(
  tx: Database,
  stackId: string | null,
  domain: string | null,
): Promise<void> {
  // Both are the caller's own values, never derived from another row. Setting the
  // id lets the policy match by id; setting the domain covers the domain-only
  // path, where no id exists yet.
  if (stackId !== null) {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
  }
  if (domain !== null && domain !== "") {
    await tx.execute(sql`select set_config('app.stack_domain', ${domain}, true)`);
  }
}
