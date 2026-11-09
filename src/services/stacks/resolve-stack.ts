/**
 * @file src/services/stacks/resolve-stack.ts
 * @description The Stack a command works on: selected, then — when it is the
 * default — materialized.
 *
 * ## Why this composes instead of deciding
 *
 * Choosing a Stack (`selectStack`) is pure and provisioning the default
 * (`ensureDefaultStack`) is not, so the two live apart and this module is the one
 * place that joins them. Nothing here re-derives a precedence or a domain: a second
 * copy of either would be a second answer to "which Stack am I on", which is the
 * defect this whole change removes.
 *
 * ## The two selections are not symmetric, and that is deliberate
 *
 * An `explicit` selection — `--stack`, or `AKS_STACK_ID` — is returned AS GIVEN,
 * with no database round trip and no existence check. That is today's behaviour for
 * a configured deployment: the Stack named in the environment is the Stack the
 * command uses, and a caller that must refuse an unknown id checks it itself. This
 * function is not that check.
 *
 * The `default` selection is different in kind. It names a DOMAIN, and a domain is
 * not an id until a row carries it, so the Stack has to exist before anything can be
 * keyed by it. Provisioning is therefore part of resolving, and it is idempotent:
 * every later use reuses the row the first use created.
 *
 * ## "Nothing configured" is not the same question as "is a Stack needed"
 *
 * A caller that only touches ONE dimension does not always need a Stack. `compile`
 * retires deleted sources from the graph and nothing else, so a project that never
 * enabled `kg` has no use for the Stack its default selection would have to
 * provision — and provisioning means a database connection on a code path that used
 * to be entirely local. {@link resolveStackForDimensions} answers that question
 * BEFORE resolving, from the switch alone, so the answer never depends on an error
 * message or on a connection.
 *
 * ## Where `--stack` enters
 *
 * At the CLI, and through the environment slot: `src/cli/stack-option.ts` validates a
 * named id and writes `AKS_STACK_ID` for the run, so `selectStack` sees a flag as an
 * `explicit` selection and this signature never has to carry a second Stack argument.
 * The flag is the caller-level override; the resolution stays here, once.
 */

import type { Database } from "@repo/kg";
import { selectStack } from "../../dimensions/stack-selection.js";
import { DIMENSIONS_ENV_VAR } from "../../dimensions/activation.js";
import type { DimensionName } from "../../dimensions/types.js";
import { ensureDefaultStack } from "./default-stack.js";

/** The dimension enabled when the switch is absent, empty, or all separators. */
const DEFAULT_DIMENSION_NAME: DimensionName = "wiki";

/**
 * The dimension names `LLMWIKI_DIMENSIONS` enables.
 *
 * MUST MIRROR `activation`'s parser, default included: unset, empty, and a value
 * made only of separators all mean `wiki` alone. It is deliberately NOT a validator
 * — an unknown name is left for `resolveDimensions` to refuse in its own words, so
 * this pre-check can never describe a misconfiguration differently from the
 * resolver that will reject it a moment later.
 *
 * @param env - The one environment the run reads.
 * @returns The enabled dimension names, in the order the switch lists them.
 */
function enabledDimensionNames(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env[DIMENSIONS_ENV_VAR]?.trim() ?? "";
  if (raw === "") return [DEFAULT_DIMENSION_NAME];
  const names = raw.split(",").map((token) => token.trim()).filter((name) => name !== "");
  return names.length === 0 ? [DEFAULT_DIMENSION_NAME] : names;
}

/**
 * Resolve the Stack a Stack-scoped command must work on.
 *
 * @param db - Handle from `createDimensionsDatabase`, used for provisioning the
 *   default Stack and for nothing else.
 * @param env - Environment to read the configured Stack from; defaults to
 *   `process.env`.
 * @returns The configured Stack id, or the id of the default Stack.
 * @throws {Error} when the default Stack can neither be read nor created; see
 *   `ensureDefaultStack`.
 */
export async function resolveStackForCommand(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const selection = selectStack({ env });
  if (selection.kind === "explicit") return selection.stackId;
  return await ensureDefaultStack(db);
}

/**
 * The Stack a caller needs for the dimensions it will actually touch, or none.
 *
 * Answers `undefined` in exactly one situation: the workspace configured no Stack
 * (so selection is the default domain, which has to be provisioned before it is an
 * id) AND the switch enables none of `dimensions`. There is no dimension work in
 * that case, so there is nothing to provision and no connection to open.
 *
 * Every other case resolves exactly as a command does. An explicit selection needs
 * no lookup, and an enabled dimension needs a real Stack — so a caller that would
 * have resolved anyway sees no difference.
 *
 * Called BEFORE any resolution at the site that needs it, never as a way to react to
 * a failed one: deciding from a thrown message would couple control flow to wording
 * and spend a provisioning attempt on a misconfiguration.
 *
 * @param db - Handle used to provision the default Stack, and for nothing else.
 * @param env - The one environment the run reads.
 * @param dimensions - The dimensions this caller will actually use.
 * @returns The Stack id to bind them to, or `undefined` when none is needed.
 * @throws {Error} when the default Stack can neither be read nor created; see
 *   `ensureDefaultStack`.
 */
export async function resolveStackForDimensions(
  db: Database,
  env: NodeJS.ProcessEnv,
  dimensions: readonly DimensionName[],
): Promise<string | undefined> {
  const selection = selectStack({ env });
  // Only the DEFAULT selection can be pointless: an explicit one was asked for out
  // loud, and it costs no round trip to honour. Selection is pure, so asking it a
  // second time below is the same answer, not a second opinion.
  if (selection.kind === "default" && !needsAnyOf(env, dimensions)) {
    return undefined;
  }
  return await resolveStackForCommand(db, env);
}

/**
 * True when the switch enables at least one of `dimensions`.
 *
 * @param env - The one environment the run reads.
 * @param dimensions - The dimensions the caller will touch.
 */
function needsAnyOf(env: NodeJS.ProcessEnv, dimensions: readonly DimensionName[]): boolean {
  const enabled = enabledDimensionNames(env);
  return dimensions.some((name) => enabled.includes(name));
}
