/**
 * @file src/mcp/tenant-db.ts
 * @description Open a tenant-bound dimensions connection for one MCP tool call.
 *
 * ## Why this is shared
 *
 * The job tools and the Stack tools both need the same three things: the bound
 * Stack id, a database handle, and a way to say "this project cannot answer"
 * instead of returning an empty result that reads like an answer. Keeping one copy
 * means the two families of tool cannot drift on the message a caller sees when no
 * Stack is configured, which is the state most likely to be hit first.
 *
 * ## Answering without a Stack
 *
 * A project with no `AKS_STACK_ID` has nowhere durable to read from, so tools
 * report that plainly. The distinction matters: an empty list IS an answer, and
 * this is an inability to answer — a client that showed them the same way would
 * hide a misconfiguration as "nothing here".
 */

import { sql } from "drizzle-orm";
import { createDimensionsDatabase, resolveStackId } from "../dimensions/activation.js";

/** Every tool that needs a Stack says this when the project has none. */
const NO_STACK_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

/**
 * Shape a Stack id must have before it is allowed near the database.
 *
 * Checked before the query, not left to Postgres: an invalid-uuid string makes the
 * `uuid` cast raise, and that error surfaces to the caller as an internal failure
 * when the honest answer is "that is not a Stack id".
 */
const STACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The handle type, taken from the factory so it cannot drift from it. */
export type TenantDatabase = ReturnType<typeof createDimensionsDatabase>["db"];

/**
 * Run `work` against the dimensions database, closing the handle afterwards.
 *
 * Mirrors how the ingest service opens a connection per operation: a long-lived
 * pool would keep the event loop alive for an MCP server that may only ever answer
 * one question.
 *
 * @param work - Receives the handle and the Stack id this call is about.
 * @param requestedStackId - A Stack the caller named, or absent to use the bound one.
 *   Omitted MUST behave exactly as before: an existing caller sees no change.
 * @returns Whatever `work` returned, or the "cannot answer" marker.
 */
export async function withTenantDatabase<T>(
  work: (db: TenantDatabase, stackId: string) => Promise<T>,
  requestedStackId?: string,
): Promise<T | { readonly unavailable: string } | { readonly unknownStack: string }> {
  if (requestedStackId !== undefined) {
    const problem = stackIdProblem(requestedStackId);
    if (problem !== undefined) return { unavailable: problem };
  }
  let stackId: string;
  try {
    stackId = requestedStackId ?? resolveStackId(process.env);
  } catch {
    return { unavailable: NO_STACK_MESSAGE };
  }
  const dimensionsDb = createDimensionsDatabase(process.env);
  try {
    // Only a CALLER-NAMED Stack is verified: the bound one already exists by
    // construction, and checking it would add a round trip to every existing call.
    if (requestedStackId !== undefined && !(await stackExists(dimensionsDb.db, stackId))) {
      return { unknownStack: stackId };
    }
    return await work(dimensionsDb.db, stackId);
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Is this Stack id well formed?
 *
 * @param stackId - The id a caller supplied.
 * @returns A caller-facing explanation when it is not, or `undefined` when it is.
 */
export function stackIdProblem(stackId: string): string | undefined {
  if (STACK_ID_PATTERN.test(stackId)) return undefined;
  return (
    `'${stackId}' is not a Stack id. Stack ids are UUIDs — call list_stacks to see ` +
    "the ones this endpoint can reach."
  );
}

/**
 * Does this Stack exist?
 *
 * Asked for every caller-named Stack, because zero rows is ambiguous without it: a
 * Stack that does not exist and a Stack that has simply never run a job both return
 * an empty list, and a client would render the first as a valid empty Stack.
 *
 * @param db - Handle from `createDimensionsDatabase`.
 * @param stackId - A validated Stack id.
 * @returns True when a row exists.
 */
export async function stackExists(db: TenantDatabase, stackId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`select id from stacks where id = ${stackId}`);
  return rows.length > 0;
}

/** True when a helper handed back the "no such Stack" marker. */
export function isUnknownStack(
  value: unknown,
): value is { readonly unknownStack: string } {
  return typeof value === "object" && value !== null && "unknownStack" in value;
}

/** The two ways a Stack-scoped helper can refuse to answer. */
export type Refusal =
  | { readonly unavailable: string }
  | { readonly unknownStack: string };

/**
 * Is this a refusal rather than a result?
 *
 * A PREDICATE rather than a value-returning formatter, because the caller needs the
 * success case narrowed: after `if (isRefusal(x)) return …`, `x` must be the real
 * payload, and only a type guard gives TypeScript that.
 *
 * @param value - Whatever the helper returned.
 * @returns True when the helper refused.
 */
export function isRefusal(value: unknown): value is Refusal {
  return isUnavailable(value) || isUnknownStack(value);
}

/**
 * The error result a tool returns for either refusal.
 *
 * Shared so the three Stack-scoped tools cannot drift into two vocabularies for one
 * condition, and because three hand-copied copies of the same branch is the
 * duplication `fallow` flags.
 *
 * @param refusal - A value already narrowed by {@link isRefusal}.
 * @returns The MCP error result.
 */
export function refusalResult(refusal: Refusal): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const text = isUnknownStack(refusal)
    ? `No Stack '${refusal.unknownStack}' exists.`
    : refusal.unavailable;
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** True when a helper handed back the "cannot answer" marker. */
function isUnavailable(
  value: unknown,
): value is { readonly unavailable: string } {
  return typeof value === "object" && value !== null && "unavailable" in value;
}
