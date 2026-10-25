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

/**
 * Binds the domain of a Stack that is ABOUT TO BE CREATED.
 *
 * ## Why this exists separately from {@link bindTenant}
 *
 * Creating a Stack is the one write where the row being written IS the tenant, so
 * there is no `stack_id` to bind — it is what the INSERT is about to produce. Under
 * the write policies in `db/migration_rls_write_policies.sql`, `stacks` therefore
 * validates against `app.stack_domain` instead of `app.stack_id`:
 *
 *   with check (domain = nullif(current_setting('app.stack_domain', true), '')::uuid)
 *
 * Without this call that predicate evaluates to NULL, the INSERT is refused, and
 * `POST /stacks` fails closed. Failing closed is the right behaviour; being unable
 * to create a Stack at all is not.
 *
 * ## Why it must run BEFORE the duplicate check
 *
 * The `stacks` READ policy also accepts a domain match. `createStack` first looks
 * for an existing Stack with the same domain, and under RLS that lookup only sees
 * the row if the domain is already bound. Binding here means the 409 a caller gets
 * for a duplicate is the real answer rather than "no duplicate found" followed by
 * a constraint violation from the INSERT.
 *
 * It is a no-op while the application connects as a role that bypasses RLS, which
 * is why it can land before the migration is applied.
 *
 * @param tx - The creating transaction.
 * @param domain - The domain the caller asked for, already validated.
 */
export async function bindCreatingStackDomain(
  tx: Database,
  domain: string,
): Promise<void> {
  await tx.execute(sql`select set_config('app.stack_domain', ${domain}, true)`);
}

/** A resolved Stack, or the error to answer with instead. */
export type StackResolution =
  | { readonly ok: true; readonly stack: StackRow }
  | { readonly ok: false; readonly error: ApiError };

/**
 * Binds the tenant named by the CALLER, before any query touches it.
 *
 * ## The order problem this exists to solve
 *
 * `resolveStack` used to read `stacks` first and call {@link bindTenant} with the
 * id it found. Under RLS that is circular and cannot work: the `stacks` read policy
 * matches only the bound tenant, so with no binding the SELECT returns nothing, the
 * resolver answers 404 for a Stack that exists, and `bindTenant` is never reached.
 *
 * The circularity is avoidable because the caller already told us which tenant it
 * means. `?stack_id=<uuid>` is the binding, and so is `?domain=<slug>`. Hiding the
 * id until after a privileged read was never protecting anything: with a single
 * shared API key (`auth.ts` attaches no principal and owns no rows per key) the id
 * IS the caller's whole authority claim. Binding it up front changes nothing about
 * who may read what — the policies still refuse every other tenant — and removes
 * the need for a `SECURITY DEFINER` function, i.e. for elevated rights inside the
 * request path.
 *
 * Both settings are set. `stacks` accepts either match, so binding only the id
 * would make a domain-only lookup invisible, and binding only the domain would make
 * an id-only lookup invisible.
 *
 * A missing reference binds nothing, and the policies then match nothing — the
 * correct fail-closed answer, produced by the database rather than by a guard.
 *
 * @param tx - Transaction that will carry the lookup.
 * @param stackId - Canonical UUID text the caller supplied, or `null`.
 * @param domain - Domain slug the caller supplied, or `null`.
 */
export async function bindCallerStack(
  tx: Database,
  stackId: string | null,
  domain: string | null,
): Promise<void> {
  if (stackId !== null && stackId !== "") {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
  }
  if (domain !== null && domain !== "") {
    await tx.execute(sql`select set_config('app.stack_domain', ${domain}, true)`);
  }
}

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

  // Bind from the caller's own reference BEFORE reading. See {@link bindCallerStack}:
  // under RLS the read is otherwise invisible and this returns a false 404.
  await bindCallerStack(tx, stackId, domain);

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
