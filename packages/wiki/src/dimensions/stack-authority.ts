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
 *   2. Otherwise, with a database configured, the caller MUST have named one: nothing
 *      is provisioned and nothing is read from the filesystem, so the run refuses by
 *      name — see {@link unnamedStackRefusal}.
 *   3. Otherwise — no database configured at all — the explicit file-backed mode.
 *
 * Step 2 used to resolve a Stack through the database-backed resolver, which
 * provisioned a default one. That is deleted, not bypassed (S1 of the feature spec):
 * a Stack exists because its owner created it, and a run that names none is refused
 * in the resolver's words instead of being handed a row nobody asked for.
 *
 * And the case this module exists for: a database IS configured and no Stack can be
 * resolved. That throws {@link StackAuthorityError} naming what is missing and what
 * would fix it. It never returns a file authority and never returns `undefined`.
 *
 * ## The one question it does not answer
 *
 * Whether a Stack is needed AT ALL — the pre-check `resolve-stack` makes from the
 * dimension switch before spending any resolution. That question is answered there,
 * and a caller that may skip asking for a Stack asks it there first; the two kinds
 * here cannot express "no Stack needed", and inventing a third one would let a
 * caller skip the decision this module was built to make.
 */

import type { DatabaseHandle } from "@repo/foundation";
import { AKS_DATABASE_URL_ENV_VAR, AKS_STACK_ID_ENV_VAR, isDatabaseConfigured } from "./activation.js";
import {
  missingStackRefusal,
  resolveStackForCommand,
  unnamedStackRefusal,
} from "../services/stacks/resolve-stack.js";

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
   * Accepted for the caller's convenience and never read: resolution now provisions
   * nothing, so which Stack a run works on is never a database question at this
   * layer. The field stays because callers that open a handle for their own reasons
   * should not have to branch before calling, and the handle is supplied by the
   * caller instead of opened here so that resolving an authority never owns the
   * lifetime of a pool it did not create.
   */
  readonly db?: DatabaseHandle | undefined;
}

/** What a caller that cannot wait for a database already knows. */
export interface SettledStackAuthorityRequest {
  /** An authority the caller resolved earlier; handed back untouched when present. */
  readonly authority?: StackAuthority | undefined;
  /** Stack id the caller named — MCP, ingest, a CLI `--stack`. Blank means none. */
  readonly stackId?: string | undefined;
  /** The one environment the run reads; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/** The Stack id a caller named, without surrounding space; `""` when it named none. */
function namedStackId(stackId: string | undefined): string {
  return stackId?.trim() ?? "";
}

/**
 * The authority the caller's OWN facts settle, or `undefined` when only a database can.
 *
 * THE caller-id test and THE file-mode decision of this module: a non-blank id is a
 * Stack, and no configured database is the named file mode. Both entries below branch
 * on this one answer, so neither keeps its own copy of either question — which is the
 * drift this module was built to end.
 *
 * @param stackId - The id the caller named, if any.
 * @param env - The one environment the run reads.
 * @returns The settled authority, or `undefined` when a database is configured and the
 *   caller named no Stack.
 */
function settledAuthority(
  stackId: string | undefined,
  env: NodeJS.ProcessEnv,
): StackAuthority | undefined {
  const supplied = namedStackId(stackId);
  if (supplied !== "") return { kind: "stack", stackId: supplied };
  if (!isDatabaseConfigured(env)) return { kind: "file", reason: NO_DATABASE_CONFIGURED };
  return undefined;
}

/**
 * Resolve which Stack this run works on.
 *
 * @param request - The caller's Stack id, the environment, and the handle it already
 *   opened; all optional, with the environment defaulting to `process.env` and an
 *   empty request meaning "nothing configured".
 * @returns A `stack` authority, or the named `file` authority when no database is
 *   configured at all.
 * @throws {StackAuthorityError} when a database is configured and the caller named no
 *   Stack — the resolver's own refusal, in this module's error type.
 */
export async function resolveStackAuthority(
  request: StackAuthorityRequest = {},
): Promise<StackAuthority> {
  const env = request.env ?? process.env;
  const settled = settledAuthority(request.stackId, env);
  if (settled !== undefined) return settled;
  if (request.db === undefined) throw new StackAuthorityError(unnamedStackRefusal());
  return { kind: "stack", stackId: await namedStackOrRefuse(request.db, env) };
}

/**
 * Resolve the authority a synchronous caller can settle WITHOUT asking the database.
 *
 * Deliberately NOT `resolveStackAuthority` under a second name, and named for the narrower
 * thing it does: the async resolver needs an `await`, so it is out of this entry's reach,
 * and the entry says so instead of guessing. Its whole contract is three answers:
 *
 *   1. an authority the caller already resolved is returned as-is, untouched;
 *   2. otherwise a non-blank caller-supplied id yields the `stack` authority;
 *   3. otherwise it answers the named `file` mode when no database is configured at all,
 *      and REFUSES when one is: a caller that could not wait must never let a configured
 *      database turn into a file-backed result.
 *
 * The refusal is worded for THIS caller, because only the caller can say how it would
 * otherwise have obtained a Stack; the situation is the resolver's, so the sentence stem
 * is the resolver's too.
 *
 * A caller that can await uses {@link resolveStackAuthority} and gets the resolution step
 * this entry lacks.
 *
 * @param request - The authority already resolved, the id the caller named, and the
 *   environment; all optional, with the environment defaulting to `process.env`.
 * @param context - What needs the authority, named in the refusal — only the caller can say
 *   how it would otherwise have obtained a Stack.
 * @returns The `stack` authority, or the named `file` authority.
 * @throws {StackAuthorityError} when a database is configured and nothing settled it.
 */
export function resolveStackAuthorityWithoutLookup(
  request: SettledStackAuthorityRequest,
  context: string,
): StackAuthority {
  if (request.authority !== undefined) return request.authority;
  const env = request.env ?? process.env;
  const settled = settledAuthority(request.stackId, env);
  if (settled !== undefined) return settled;
  throw new StackAuthorityError(
    missingStackRefusal(
      `${context} was given no resolved authority and cannot ask the database resolver itself.`,
      `Pass the authority the run resolved, or name the Stack in ${AKS_STACK_ID_ENV_VAR}.`,
    ),
  );
}

/**
 * The Stack the database-backed resolver names, refusing to answer nothing.
 *
 * `resolveStackForCommand` answers the id the caller named or refuses, and can only
 * answer a blank id on a defect; both are the same outcome here — a configured
 * database that produced no Stack — so both are reported in THIS module's error type,
 * carrying the resolver's own sentence rather than a second wording of it.
 *
 * @param db - Handle accepted for the caller's convenience; the resolver reads nothing
 *   from it, because nothing is provisioned any more.
 * @param env - The one environment the run reads.
 * @returns The resolved, non-blank Stack id.
 * @throws {StackAuthorityError} when nothing was resolvable.
 */
async function namedStackOrRefuse(db: DatabaseHandle, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const stackId = await resolveStackForCommand(db, env);
    if (stackId.trim() === "") throw new Error("the resolver answered with a blank Stack id");
    return stackId;
  } catch (error) {
    throw new StackAuthorityError(unnamedStackRefusal(), { cause: error });
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
