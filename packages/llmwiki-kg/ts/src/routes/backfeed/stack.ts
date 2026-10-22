/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/stack.ts
 * @description `resolve_stack` — turning a `stack_id`/`domain` pair into an id.
 *
 * Split out of `routes/backfeed.ts` as its own unit because its three measured
 * failure modes (422 for neither, 404 for unknown) are shared by the flag and
 * queue endpoints, and `stack_id` wins when both are supplied.
 */

import { sql } from "drizzle-orm";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import type { ApiError } from "../../errors.js";

/** Result of resolving a Stack reference. */
export type StackResolution =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: ApiError };

/**
 * `resolve_stack` from `app/core/stack_resolver.py`.
 *
 * Three distinct failures, all measured:
 *
 * - neither `stack_id` nor `domain` supplied (including `domain: ""`, because
 *   Python's check is a truthiness test) -> **422** with a plain-string
 *   `detail`, not the 422 error array;
 * - `stack_id` given but unknown -> 404, naming the canonical lowercase UUID;
 * - `domain` given but unknown -> 404, naming the domain.
 *
 * When both are supplied `stack_id` wins, because Python branches on it first.
 * Measured: a valid `stack_id` with a nonexistent `domain` answers 201.
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
      ? await tx.execute<{ readonly id: string }>(sql`
          select id from stacks where id = ${stackId}
        `)
      : await tx.execute<{ readonly id: string }>(sql`
          select id from stacks where domain = ${domain}
        `);

  const row = rows[0];
  if (row === undefined) {
    const ident = stackId !== null ? stackId : domain;
    return { ok: false, error: apiError(404, `Stack '${String(ident)}' not found`) };
  }

  return { ok: true, id: row.id };
}
