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

import { createDimensionsDatabase, resolveStackId } from "../dimensions/activation.js";

/** Every tool that needs a Stack says this when the project has none. */
const NO_STACK_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

/** The handle type, taken from the factory so it cannot drift from it. */
export type TenantDatabase = ReturnType<typeof createDimensionsDatabase>["db"];

/**
 * Run `work` against the dimensions database, closing the handle afterwards.
 *
 * Mirrors how the ingest service opens a connection per operation: a long-lived
 * pool would keep the event loop alive for an MCP server that may only ever answer
 * one question.
 *
 * @param work - Receives the handle and the bound Stack id.
 * @returns Whatever `work` returned, or the "cannot answer" marker.
 */
export async function withTenantDatabase<T>(
  work: (db: TenantDatabase, stackId: string) => Promise<T>,
): Promise<T | { readonly unavailable: string }> {
  let stackId: string;
  try {
    stackId = resolveStackId(process.env);
  } catch {
    return { unavailable: NO_STACK_MESSAGE };
  }
  const dimensionsDb = createDimensionsDatabase(process.env);
  try {
    return await work(dimensionsDb.db, stackId);
  } finally {
    await dimensionsDb.close();
  }
}

/** True when a helper handed back the "cannot answer" marker. */
export function isUnavailable(
  value: unknown,
): value is { readonly unavailable: string } {
  return typeof value === "object" && value !== null && "unavailable" in value;
}
