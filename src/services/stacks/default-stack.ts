/**
 * @file src/services/stacks/default-stack.ts
 * @description The one Stack a workspace writes to when it configured none.
 *
 * ## Why a materialized Stack rather than a silent fallback
 *
 * Defaulting an ingest to "some Stack" without creating it is what the recorded
 * product decision refused, and rightly: pages and entities would land in a tenant
 * nobody can name, list, or find again. This module therefore provisions a REAL
 * row — `domain` = `default`, `name` = `Default` — so the default is exactly as
 * addressable as any other Stack, and a later explicit `--stack default` reaches
 * the same rows.
 *
 * ## Idempotent, and never an update
 *
 * `insert ... on conflict (domain) do nothing` followed by a `select` is the whole
 * write path. `on conflict ... do update` would let a second run rename or re-domain
 * a Stack an operator already owns; a bare `insert` would make the second run fail.
 * Nothing here updates any column of an existing row.
 *
 * ## Row-level security, and the route taken
 *
 * `stacks` carries ONE `FOR ALL` policy, in
 * `packages/llmwiki-kg/db/migration_rls_tenancy.sql`, whose `WITH CHECK` is omitted —
 * so Postgres validates writes against the same `USING` predicate (measured) and it
 * governs reads AND writes:
 *
 *   using (id = nullif(current_setting('app.stack_id', true), '')::uuid
 *          or domain = nullif(current_setting('app.stack_domain', true), ''))
 *
 * Creating a Stack is the one write where the row IS the tenant, so `app.stack_id`
 * cannot be known yet and the domain half is the only binding available. This module
 * therefore binds `app.stack_domain` to the domain it is about to create BEFORE the
 * insert — the same route `bindCreatingStackDomain` takes for `POST /stacks`, which
 * is not reachable from here because the vendored core's barrel does not export it.
 * Binding first also makes the duplicate lookup a real answer under RLS, since the
 * read half accepts the domain match too.
 *
 * A refusal that survives the binding (an operator whose role cannot write `stacks`,
 * a missing table) surfaces as a typed error naming the domain, never as a silent
 * miss.
 */

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import { DEFAULT_STACK_DOMAIN, DEFAULT_STACK_NAME } from "../../dimensions/stack-selection.js";

/** Narrow a caught value to a message worth appending to ours. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The default Stack could neither be found nor created. */
class DefaultStackProvisionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DefaultStackProvisionError";
  }
}

/**
 * The Stack a workspace with no configured Stack writes to, created on first use.
 *
 * @param db - Handle from `createDimensionsDatabase`.
 * @returns The Stack id owning the default domain, existing or freshly created.
 * @throws {DefaultStackProvisionError} when the domain is unreadable or unwritable,
 *   including a row-level-security refusal.
 */
export async function ensureDefaultStack(db: DatabaseHandle): Promise<string> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.stack_domain', ${DEFAULT_STACK_DOMAIN}, true)`,
      );
      await tx.execute(sql`
        insert into stacks (name, domain)
        values (${DEFAULT_STACK_NAME}, ${DEFAULT_STACK_DOMAIN})
        on conflict (domain) do nothing
      `);
      const rows = await tx.execute<{ id: string }>(
        sql`select id from stacks where domain = ${DEFAULT_STACK_DOMAIN}`,
      );
      const stackId = rows[0]?.id;
      if (stackId === undefined) {
        throw new DefaultStackProvisionError(
          `The default Stack at domain "${DEFAULT_STACK_DOMAIN}" could not be created or read back. ` +
            `Check that the connection in AKS_DATABASE_URL may write to the stacks table.`,
        );
      }
      return stackId;
    });
  } catch (error) {
    if (error instanceof DefaultStackProvisionError) throw error;
    throw new DefaultStackProvisionError(
      `The default Stack at domain "${DEFAULT_STACK_DOMAIN}" could not be provisioned: ${messageOf(error)}. ` +
        `Check that the connection in AKS_DATABASE_URL reaches a database with the stacks table.`,
      { cause: error },
    );
  }
}
