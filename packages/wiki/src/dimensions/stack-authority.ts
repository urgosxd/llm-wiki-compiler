/**
 * @file src/dimensions/stack-authority.ts
 * @description Which Stack a run works on — resolved ONCE, into a value that says
 * whether the run has a Stack at all.
 *
 * ## Why an authority value instead of an id
 *
 * The Stack used to be read inline at every seam that needed one, and each seam
 * decided on `stackId === ""`: an empty id silently degraded a row-backed store to
 * the file backend. That guard cannot tell the two situations apart, because they
 * are the same input. "This wiki has no database, so it is file-backed" is a
 * supported mode; "this deployment's database answered no Stack" is a fault that has
 * to be reported. Twenty copies of one guard therefore turned every fault into a
 * working-looking file-backed result.
 *
 * The split happens here, once, and its answer is a VALUE a caller can branch on:
 *
 *   - `{ kind: "stack", stackId }` — this run has a Stack.
 *   - `{ kind: "file", reason }` — this run is deliberately file-backed, for a named
 *     reason. Never `undefined`, never `""`.
 *
 * ## The precedence, and what it reuses
 *
 *   1. A caller-supplied Stack id (non-blank) wins outright. Nothing is looked up.
 *   2. Otherwise, with a database configured, the database-backed resolver supplies
 *      it: `resolveStackForCommand`, which honours an explicitly selected Stack and
 *      otherwise provisions the Stack at {@link DEFAULT_STACK_DOMAIN} through
 *      `ensureDefaultStack`. Both are CALLED, never re-implemented — a second copy
 *      of either would be a second answer to "which Stack am I on".
 *   3. Otherwise — no database configured at all — the explicit file-backed mode.
 *
 * And the case this module exists for: a database IS configured and no Stack can be
 * resolved. That throws {@link StackAuthorityError} naming the Stack that is missing
 * and what would fix it. It never returns a file authority and never returns
 * `undefined`.
 *
 * ## The one question it does not answer
 *
 * Whether a Stack has to be provisioned AT ALL — the pre-check `resolve-stack` makes
 * from the dimension switch before spending a connection. That question is answered
 * there, and a caller that must skip provisioning asks it there first; the two kinds
 * here cannot express "no Stack needed", and inventing a third one would let a
 * caller skip the decision this module was built to make.
 */

import type { DatabaseHandle } from "@repo/foundation";
import { AKS_DATABASE_URL_ENV_VAR, isDatabaseConfigured } from "./activation.js";
import { DEFAULT_STACK_DOMAIN } from "./stack-selection.js";
import { resolveStackForCommand } from "../services/stacks/resolve-stack.js";

/** Why a run is file-backed, as a value rather than an absent id. */
export type FileBackedReason = "no-database-configured";

/** The only file-backed reason there is: nothing configured a database. */
export const NO_DATABASE_CONFIGURED: FileBackedReason = "no-database-configured";

/**
 * The Stack authority for one run.
 *
 * Kept as two named kinds rather than a nullable id because the difference decides
 * control flow downstream: `stack` may be converted to an id and used for row-backed
 * work, and `file` may not — a contract that needs one must refuse, not degrade.
 */
export type StackAuthority =
  | { readonly kind: "stack"; readonly stackId: string }
  | { readonly kind: "file"; readonly reason: FileBackedReason };

/** A run that must have a Stack and has none. */
export class StackAuthorityError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StackAuthorityError";
  }
}

/** What the boundary knows when it resolves the authority. */
export interface StackAuthorityRequest {
  /** Stack id the caller named — MCP, ingest, a CLI `--stack`. Blank means none. */
  readonly stackId?: string | undefined;
  /** The one environment the run reads; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The database handle this run already opened.
   *
   * Required only when a database is configured: resolving via
   * `resolveStackForCommand` provisions the default Stack, which needs a connection.
   * The handle is supplied by the caller instead of opened here so that resolving an
   * authority never owns the lifetime of a pool it did not create.
   */
  readonly db?: DatabaseHandle | undefined;
}

/** A message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve which Stack this run works on.
 *
 * @param request - The caller's Stack id, the environment, and the handle to use when
 *   a database is configured; all optional, with the environment defaulting to
 *   `process.env` and an empty request meaning "nothing configured".
 * @returns A `stack` authority, or the named `file` authority when no database is
 *   configured at all.
 * @throws {StackAuthorityError} when a database is configured and no Stack can be
 *   resolved, or when one is configured and no handle was supplied.
 */
export async function resolveStackAuthority(
  request: StackAuthorityRequest = {},
): Promise<StackAuthority> {
  const supplied = request.stackId?.trim() ?? "";
  if (supplied !== "") return { kind: "stack", stackId: supplied };

  const env = request.env ?? process.env;
  if (!isDatabaseConfigured(env)) return { kind: "file", reason: NO_DATABASE_CONFIGURED };
  if (request.db === undefined) {
    throw new StackAuthorityError(
      `${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack, but no database ` +
        `handle was supplied to resolve it. Pass the handle the run already opened, or pass the ` +
        `Stack id explicitly.`,
    );
  }
  return { kind: "stack", stackId: await defaultStackOrRefuse(request.db, env) };
}

/**
 * The Stack the database-backed resolver answers, refusing to answer nothing.
 *
 * `resolveStackForCommand` throws for its own reasons and can only answer an empty
 * id on a defect; both are the same outcome here — a configured database that
 * produced no Stack — so both are reported with THIS module's wording, naming the
 * Stack that is missing and the two ways to fix it.
 *
 * @param db - Handle to resolve through.
 * @param env - The one environment the run reads.
 * @returns The resolved, non-blank Stack id.
 * @throws {StackAuthorityError} when nothing was resolvable.
 */
async function defaultStackOrRefuse(db: DatabaseHandle, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const stackId = await resolveStackForCommand(db, env);
    if (stackId.trim() === "") throw new Error("the resolver answered with a blank Stack id");
    return stackId;
  } catch (error) {
    throw new StackAuthorityError(
      `${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack, but no Stack was ` +
        `resolvable at domain "${DEFAULT_STACK_DOMAIN}": ${messageOf(error)}. ` +
        `Either pass the Stack id explicitly, or make the configured database reachable with the ` +
        `stacks table so the default Stack can be created.`,
      { cause: error },
    );
  }
}

/**
 * The plain Stack id a site still needs, or none.
 *
 * THE ONE CONVERSION from the authority to an id, so the file-to-`undefined` step
 * exists in a single place: sites that can fall back to the file backend call this
 * and branch on the result, instead of each re-deciding on an empty string.
 *
 * @param authority - A resolved authority.
 * @returns The Stack id, or `undefined` in the file-backed mode.
 */
export function stackIdOf(authority: StackAuthority): string | undefined {
  return authority.kind === "stack" ? authority.stackId : undefined;
}

/**
 * The Stack id a row-mandatory contract requires, refusing the file-backed mode.
 *
 * For contracts that cannot degrade: a table keyed by Stack, a row written under one.
 * Answering `undefined` there is what let a missing Stack look like a file-backed
 * success, so this fails with the named mode and the setting that would end it.
 *
 * @param authority - A resolved authority.
 * @param context - What needs the Stack, named in the refusal.
 * @returns The Stack id.
 * @throws {StackAuthorityError} in the file-backed mode.
 */
export function requireStackId(authority: StackAuthority, context: string): string {
  if (authority.kind === "stack") return authority.stackId;
  throw new StackAuthorityError(
    `${context} requires a Stack, but this run is file-backed: no Stack exists because ` +
      `${AKS_DATABASE_URL_ENV_VAR} is not configured. Set it to a database with the stacks table, ` +
      `or stop asking a file-backed wiki for row-backed state.`,
  );
}
