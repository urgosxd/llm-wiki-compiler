/**
 * @file src/services/stacks/stack-store.ts
 * @description Read the Stacks this deployment can reach, newest first.
 *
 * ## Why this exists
 *
 * An MCP client could address exactly one Stack — the one its process was started
 * with (`AKS_STACK_ID`, resolved by `resolveStackId`) — because no tool or resource
 * ever named a Stack. A consumer that wants to offer a Stack picker had no way to
 * discover the ids, and asked for one.
 *
 * ## Why the query is written here instead of reusing `GET /stacks`
 *
 * The route lives in `packages/llmwiki-kg`, whose declaration build the core does
 * not resolve. Reaching into it from `src/mcp/**` is the constraint already
 * documented in `job-tools.ts`, so this issues its own `select`. It keeps the
 * route's semantics — newest-updated first — without copying its column list.
 *
 * ## What this deliberately does NOT do: invent a tenant filter
 *
 * `stacks` carries a row policy, and it is tempting to read that as per-tenant
 * isolation this tool must honour. It is not what the product provides. The HTTP
 * surface is explicit about it: `auth.ts` says identity is "intentionally not
 * attached to the request … there is no per-key row ownership". The boundary is the
 * API key plus one deployment per Stack-set, and `GET /stacks` lists everything the
 * connection can see.
 *
 * So this mirrors `GET /stacks` rather than narrowing it. A tool that returned only
 * the bound Stack would be a discovery tool that discovers nothing, and under the
 * shipped DSN — which connects as `POSTGRES_USER`, whose rows are not filtered — the
 * narrowing would not even take effect. Consistency with the documented HTTP answer
 * is the safer contract than a filter that holds under one role and not another.
 *
 * `withTenant` is still used, for the same reason the job reads use it: it binds the
 * Stack the caller asked about so `isCurrent` has a referent. It is not relied on to
 * hide rows.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "../../dimensions/wiki/page-store.js";

/** The database handle shape, taken from `withTenant` for the reason in `job-store.ts`. */
type Database = Parameters<typeof withTenant>[0];

/**
 * Columns a listing returns.
 *
 * `ontology` is deliberately absent even though `GET /stacks` selects it: a caller
 * picking a Stack needs its identity, not its declaration, and carrying every
 * Stack's declaration would make the answer mostly payload no picker renders.
 */
const STACK_LISTING_COLUMNS = sql`
  id, name, domain, description, scope,
  compilation_strategy, synthesize_descriptions, created_at, updated_at
`;

/** How many Stacks a listing returns when no limit is asked for. */
const DEFAULT_LIST_LIMIT = 50;

/** Ceiling on a listing, so one call cannot ask for everything. */
const MAX_LIST_LIMIT = 200;

/** One Stack as a listing sees it. */
export interface StackSummary {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly description: string | null;
  readonly scope: string;
  readonly compilationStrategy: string | null;
  readonly synthesizeDescriptions: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True for the Stack this deployment is bound to. */
  readonly isCurrent: boolean;
}

/** A `stacks` row as selected by {@link STACK_LISTING_COLUMNS}. */
type StackRow = {
  id: string;
  name: string;
  domain: string | null;
  description: string | null;
  scope: string;
  compilation_strategy: string | null;
  synthesize_descriptions: boolean;
  created_at: string;
  updated_at: string;
};

/** Map a row to the DTO, giving the snake_case columns their JSON names. */
function toStackSummary(row: StackRow, currentStackId: string): StackSummary {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    description: row.description,
    scope: row.scope,
    compilationStrategy: row.compilation_strategy,
    synthesizeDescriptions: row.synthesize_descriptions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isCurrent: row.id === currentStackId,
  };
}

/**
 * Does this Stack exist?
 *
 * Lives here rather than beside a caller because both surfaces that accept a
 * caller-named Stack need it, and neither may import the other: the viewer must stay
 * free of the MCP SDK, and the host must not reach into `src/mcp/**` (that direction
 * already caused a module cycle once).
 *
 * @param db - Handle from `createDimensionsDatabase`.
 * @param stackId - A validated Stack id.
 * @returns True when a row exists.
 */
export async function stackExists(db: Database, stackId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`select id from stacks where id = ${stackId}`);
  return rows.length > 0;
}

/**
 * List the reachable Stacks, most recently updated first.
 *
 * Ordering is contractual, not cosmetic: without it Postgres may return heap order,
 * which only looks sorted until a row is updated — the reasoning `GET /stacks`
 * records.
 *
 * The bound Stack sorts FIRST, ahead of `updated_at`. A caller's most common
 * question is "which Stack am I on", and in a deployment with thousands of Stacks
 * the bound one can sit far past any sane limit — measured here at 2915th of 2916 by
 * `updated_at`, i.e. invisible to every bounded listing and to the picker that reads
 * it. Pinning it first makes that answer independent of the limit.
 *
 * @param db - Handle from `createDimensionsDatabase`.
 * @param stackId - The bound Stack; also what the tenant policy is set from.
 * @param limit - Requested size, clamped to [1, {@link MAX_LIST_LIMIT}].
 * @returns The Stacks visible under the bound tenant, newest first.
 */
export async function listStacks(
  db: Database,
  stackId: string,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<readonly StackSummary[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<StackRow>(sql`
      select ${STACK_LISTING_COLUMNS}
      from stacks
      order by (id = ${stackId}) desc, updated_at desc
      limit ${bounded}
    `);
    return rows.map((row) => toStackSummary(row, stackId));
  });
}
