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
 * A project with no `AKS_STACK_ID` has nowhere durable to read from, so tools report
 * that plainly. The distinction matters: an empty list IS an answer, and this is an
 * inability to answer — a client that showed them the same way would hide a
 * misconfiguration as "nothing here".
 *
 * ## Why nothing here reads the ambient environment for a Stack
 *
 * The Stack now arrives only as the tool argument. Substituting `AKS_STACK_ID` when a
 * caller left the argument out meant a call with no tenant in mind was answered from
 * whichever Stack the process happened to serve — silently, and indistinguishably
 * from a deliberate request. The environment is still read for the DATABASE and, in
 * {@link withRequestEnv}, still carries the Stack id into the seams for the duration
 * of one call; it is never used to fill a missing argument.
 */

import { sql } from "drizzle-orm";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
  resolveStackId,
} from "../dimensions/activation.js";
import { stackIdProblem } from "../utils/stack-id.js";
import { stackExists } from "../services/stacks/stack-store.js";

/**
 * What this module says when a deployment has no Stack bound at all.
 *
 * Only {@link boundStackOrProblem} produces it now. Kept exported because the wording
 * is part of what a client has already seen, and the one tool that can still be called
 * without a Stack — `list_stacks` — must not invent a second vocabulary for it.
 */
export const NO_STACK_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

/**
 * The Stack a DISCOVERY tool marks as current when the caller named none.
 *
 * `list_stacks` is the one Stack-scoped tool exempt from the required-argument rule:
 * a discovery tool cannot require the identifier of the thing it discovers, and a
 * caller that has no id yet is exactly its audience. So it — and only it — still
 * resolves the Stack this deployment is bound to, which is what its own `stackId`
 * schema documents as "Omit for the bound Stack".
 *
 * Kept HERE, beside the helpers that no longer do any such thing, so the single
 * surviving ambient resolution is visible in one place instead of being re-implemented
 * by a tool. Every other tool takes its Stack from the argument and nothing else.
 *
 * @param env - Environment to resolve the deployment binding from.
 * @returns The bound Stack id, or the refusal an unbound deployment reports.
 */
export function boundStackOrProblem(env: NodeJS.ProcessEnv = process.env): string | Refusal {
  try {
    return resolveStackId(env);
  } catch {
    return { unavailable: NO_STACK_MESSAGE };
  }
}

/**
 * Shape a Stack id must have before it is allowed near the database.
 *
 * Checked before the query, not left to Postgres: an invalid-uuid string makes the
 * `uuid` cast raise, and that error surfaces to the caller as an internal failure
 * when the honest answer is "that is not a Stack id".
 */


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
 * @param stackId - The Stack the caller passed as the tool argument. Required: there
 *   is no bound Stack to fall back to, so an absent id is a caller error, not a mode.
 * @returns Whatever `work` returned, or a refusal.
 */
export async function withTenantDatabase<T>(
  work: (db: TenantDatabase, stackId: string) => Promise<T>,
  stackId: string,
): Promise<T | Refusal> {
  const problem = stackIdProblem(stackId);
  if (problem !== undefined) return { unavailable: problem };
  const dimensionsDb = createDimensionsDatabase(process.env);
  try {
    // EVERY id is caller-supplied now, so every id is verified. Skipping the check for
    // "the bound one" was only meaningful while the environment could supply one; an
    // unverified id here would answer a nonexistent Stack with an empty list.
    if (!(await stackExists(dimensionsDb.db, stackId))) {
      return { unknownStack: stackId };
    }
    return await work(dimensionsDb.db, stackId);
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Run `work` with an environment that points every seam at `stackId`.
 *
 * ## Why an env override rather than new seam signatures
 *
 * Every reader in `src/dimensions/wiki/page-source-seam.ts` already takes the
 * environment as its first argument and resolves the Stack from it. Threading a
 * second "or this Stack" parameter through each one would add a way to disagree with
 * itself — an env saying A and an argument saying B — to a set of functions whose
 * whole job is reading the environment. Overriding the env once, here, keeps a single
 * source of truth for the duration of one call.
 *
 * ## Why the process env is restored rather than mutated in place
 *
 * Two tools may be in flight at once over streamable HTTP. Assigning to
 * `process.env` would let one call's Stack leak into the other's read, which is the
 * precise cross-tenant failure this surface exists to prevent. A copy is handed to
 * the seams instead, so the ambient environment is never written.
 *
 * ## Why the id is required and no longer defaulted
 *
 * The absent case used to mean "use whatever this process is bound to", which made a
 * call that named no Stack indistinguishable from one that named the bound Stack. It
 * is now the tool argument and nothing else, so there is no branch here that reads
 * `AKS_STACK_ID` to decide which tenant to answer about.
 *
 * @param stackId - The Stack the caller passed as the tool argument.
 * @param work - Receives the environment to pass to the seams.
 * @returns Whatever `work` returned, or a refusal.
 */
export async function withRequestEnv<T>(
  stackId: string,
  work: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T | Refusal> {
  const problem = await namedStackProblem(stackId, process.env);
  if (problem !== undefined) return problem;
  return work({ ...process.env, [AKS_STACK_ID_ENV_VAR]: stackId });
}

/**
 * Refuse a Stack the caller named that this deployment cannot serve.
 *
 * ## Why this is asked HERE rather than in each tool
 *
 * The tools answer a nonexistent Stack with a well-formed empty result -- `wiki_status`
 * reporting `0 pages`, `search_pages` returning `[]`. Both read as facts about a wiki
 * and are really a fact about the id: the caller was told "this Stack is empty" when
 * the truth is "there is no such Stack". That is the failure mode this codebase keeps
 * finding, a wrong answer delivered confidently instead of an error.
 *
 * Validating once, on the way in, means a tool added later cannot forget it. The job
 * tools already did this through `withTenantDatabase`; this is the same check for the
 * tools that read pages.
 *
 * ## Why the id's SHAPE is checked before any lookup
 *
 * Every call carries an id now, so a malformed one is no longer a rare state to let
 * Postgres reject with a `uuid` cast error that surfaces as an internal failure. It is
 * refused with the message that names the argument, and without opening a connection.
 *
 * ## Why a missing database is not a refusal
 *
 * A project with no database is a supported deployment: pages live on disk and there
 * are no Stacks to look up. Refusing there would break the file-backed case that works
 * today, so the check is skipped when nothing is configured, and a FAILED lookup is
 * still a refusal -- an unreachable database must not look like a valid Stack.
 *
 * @param stackId - The Stack the caller named.
 * @param env - Environment to open the lookup with.
 * @returns A refusal, or `undefined` when the Stack may be used.
 */
async function namedStackProblem(
  stackId: string,
  env: NodeJS.ProcessEnv,
): Promise<Refusal | undefined> {
  const malformed = stackIdProblem(stackId);
  if (malformed !== undefined) return { unavailable: malformed };
  const configured = (env[AKS_DATABASE_URL_ENV_VAR] ?? "").trim();
  if (configured === "") return undefined;
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return (await stackExists(dimensionsDb.db, stackId)) ? undefined : { unknownStack: stackId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { unavailable: `Could not verify Stack '${stackId}': ${detail}` };
  } finally {
    await dimensionsDb.close();
  }
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
