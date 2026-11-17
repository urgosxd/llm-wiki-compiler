/**
 * @file src/services/stacks/resolve-stack.ts
 * @description The Stack a command works on: the id the caller named, or a refusal
 * that names what is missing — never a Stack created on the way past.
 *
 * ## Why there is no third answer any more
 *
 * This module used to join two things: choosing a Stack (`selectStack`, pure) and
 * materializing a default one (`ensureDefaultStack`, a real write). The write is
 * gone — S1 of `odd/tasks/stack-authority-per-request.md`: no Stack is created
 * implicitly, a Stack exists because its owner created it over HTTP or declared it
 * explicitly at boot — so the join is gone with it. What is left is one question
 * with two answers: the id the caller named, or the refusal.
 *
 * ## Why the refusal is worded HERE
 *
 * It is the sentence every configured-database path says when nothing named a
 * Stack, and this is the module that decides "nothing was named". `stack-authority`
 * reuses this wording instead of restating it, because two copies of a refusal that
 * must agree eventually disagree.
 *
 * ## An explicit selection is returned AS GIVEN
 *
 * An `explicit` selection — `--stack`, or `AKS_STACK_ID` — is returned AS GIVEN,
 * with no database round trip and no existence check. A caller that must refuse an
 * unknown id checks it itself. This function is not that check.
 *
 * ## "Nothing named" is not the same question as "is a Stack needed"
 *
 * A caller that only touches ONE dimension does not always need a Stack. `compile`
 * retires deleted sources from the graph and nothing else, so a project that never
 * enabled `kg` has no use for a Stack. {@link resolveStackForDimensions} answers
 * that question BEFORE resolving, from the switch alone, so the answer never
 * depends on an error message or on a connection.
 *
 * ## Where `--stack` enters
 *
 * At the CLI, and through the environment slot: `src/cli/stack-option.ts` validates
 * a named id and writes `AKS_STACK_ID` for the run, so `selectStack` sees a flag as
 * an `explicit` selection and this signature never has to carry a second Stack
 * argument. The flag is the caller-level override; the resolution stays here, once.
 */

import type { DatabaseHandle } from "@repo/foundation";
import { selectStack } from "../../dimensions/stack-selection.js";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  enabledDimensionNames,
} from "../../dimensions/activation.js";
import type { DimensionName } from "../../dimensions/types.js";

/**
 * THE sentence stem for "a database is configured, so this run must have a Stack".
 *
 * Exported so that every path reaching this situation says it in the same words: the
 * two entries below, and `stack-authority`'s entries, which reuse it rather than
 * reword what only this module decides. What THAT caller must do next is the only
 * part that genuinely differs, so it is supplied here instead of being reworded at
 * each site.
 *
 * @param whatHappened - Why this caller reached the refusal, as a clause.
 * @param remedy - What would end it, as a sentence.
 * @returns The refusal text, without a trailing newline.
 */
export function missingStackRefusal(whatHappened: string, remedy: string): string {
  return `${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack, but ${whatHappened} ${remedy}`;
}

/**
 * THE refusal for a run that has a database and named no Stack.
 *
 * The sentence states the situation, the decision that produced it, and both fixes,
 * because an operator reading it has to be able to act without reading any code. The
 * candidate this replaced named a default Stack that would be created for them; that
 * Stack is what S1 deleted, so the sentence says instead what now exists: nobody
 * creates one for you.
 *
 * @returns The refusal text, without a trailing newline.
 */
export function unnamedStackRefusal(): string {
  return missingStackRefusal(
    "no Stack was named for it, and this build never creates one implicitly.",
    `Create the Stack with POST /stacks and name its id in ${AKS_STACK_ID_ENV_VAR}, or pass --stack.`,
  );
}

/**
 * Resolve the Stack a Stack-scoped command must work on.
 *
 * @param db - Handle from `createDimensionsDatabase`. Accepted and never read: it is
 *   kept in the signature so callers that already opened one need no branch of their
 *   own, and resolution reads nothing from the database now that no Stack is
 *   provisioned.
 * @param env - Environment to read the configured Stack from; defaults to
 *   `process.env`.
 * @returns The Stack the caller named.
 * @throws {Error} {@link unnamedStackRefusal} when the caller named no Stack.
 */
export async function resolveStackForCommand(
  db: DatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return namedOrRefuse(selectStack({ env }));
}

/**
 * The Stack a caller needs for the dimensions it will actually touch, or none.
 *
 * Answers `undefined` in exactly one situation: the caller named no Stack AND the
 * switch enables none of `dimensions`. There is no dimension work in that case, so
 * there is nothing to resolve and no reason to refuse.
 *
 * Every other case resolves exactly as a command does: a named Stack needs no
 * lookup, and an enabled dimension needs a real Stack — so a caller that would have
 * resolved anyway sees no difference.
 *
 * Called BEFORE any resolution at the site that needs it, never as a way to react to
 * a failed one: deciding from a thrown message would couple control flow to wording.
 *
 * @param db - Handle accepted for the caller's convenience and never read; see
 *   {@link resolveStackForCommand}.
 * @param env - The one environment the run reads.
 * @param dimensions - The dimensions this caller will actually use.
 * @returns The Stack id to bind them to, or `undefined` when none is needed.
 * @throws {DimensionActivationError} when the switch names a dimension this build
 *   cannot write; see `enabledDimensionNames`.
 * @throws {Error} {@link unnamedStackRefusal} when a dimension is enabled and no
 *   Stack was named.
 */
export async function resolveStackForDimensions(
  db: DatabaseHandle,
  env: NodeJS.ProcessEnv,
  dimensions: readonly DimensionName[],
): Promise<string | undefined> {
  const selection = selectStack({ env });
  // Only the ABSENT selection can be pointless: an explicit one was asked for out
  // loud, and it costs no round trip to honour. Selection is pure, so asking the
  // switch does not give a second opinion on it.
  if (selection.kind === "none" && !needsAnyOf(env, dimensions)) {
    return undefined;
  }
  return namedOrRefuse(selection);
}

/**
 * The Stack a selection names, refusing the one selection that names none.
 *
 * The single place the two entries above turn a selection into an id, so neither
 * keeps its own copy of "what does an absent selection mean".
 *
 * @param selection - A resolved selection.
 * @returns The selected Stack id.
 * @throws {Error} {@link unnamedStackRefusal} when the selection names no Stack.
 */
function namedOrRefuse(selection: ReturnType<typeof selectStack>): string {
  if (selection.kind === "explicit") return selection.stackId;
  throw new Error(unnamedStackRefusal());
}

/**
 * True when the switch enables at least one of `dimensions`.
 *
 * Answered by `activation`'s reader, never by a copy of it: the switch has ONE
 * reader, so this pre-check cannot disagree with the resolver that runs a moment
 * later. That includes the refusal — an unknown name is rejected here, in the
 * activation module's own words, rather than being answered as "nothing enabled"
 * and letting a misconfigured run skip its dimension work in silence.
 *
 * @param env - The one environment the run reads.
 * @param dimensions - The dimensions the caller will touch.
 * @throws {DimensionActivationError} on a name this build cannot write.
 */
function needsAnyOf(env: NodeJS.ProcessEnv, dimensions: readonly DimensionName[]): boolean {
  const enabled = enabledDimensionNames(env);
  return dimensions.some((name) => enabled.includes(name));
}
