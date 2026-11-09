/**
 * @file src/dimensions/stack-selection.ts
 * @description Which Stack a command works on, and where that choice came from.
 *
 * ## Why this is a resolved VALUE and not an environment read
 *
 * The Stack used to be read inline from `AKS_STACK_ID` at each seam that needed
 * one, so "which Stack am I on" had as many answers as it had readers, and a
 * checkout with nothing configured was a refusal rather than a default. Selection
 * now resolves ONCE, into a value that says both what was chosen and why, and every
 * consumer downstream formats or defers to that one answer.
 *
 * Precedence, highest first:
 *
 *   1. `--stack <id>` on the command line.
 *   2. `AKS_STACK_ID`.
 *   3. The deterministic default Stack (see `DEFAULT_STACK_DOMAIN`).
 *
 * Absence is never an error: the third step always applies. Steps 1 and 2 treat a
 * blank or whitespace-only value as ABSENT, because a shell that expands
 * `--stack "$UNSET"` to the empty string meant nothing by it, and refusing there
 * would reintroduce the requirement this module removes.
 *
 * ## What this module deliberately does NOT do
 *
 * It resolves nothing against the database and provisions nothing. Turning the
 * default selection into a real Stack row is `ensureDefaultStack`, and turning an
 * explicit id into a verified one is the caller's fail-closed check. Keeping
 * selection pure is what lets it be tested without a connection.
 */

import { AKS_STACK_ID_ENV_VAR } from "./activation.js";

/** Domain of the Stack a workspace falls back to when it configured none. */
export const DEFAULT_STACK_DOMAIN = "default";

/** Name given to that Stack the one time it is created. */
export const DEFAULT_STACK_NAME = "Default";

/** Where a resolved Stack came from. */
export type StackSelectionSource = "flag" | "env" | "default";

/**
 * A Stack a command will use.
 *
 * The two shapes are kept apart rather than collapsed into a nullable id because
 * they mean different things downstream: an `explicit` id names a Stack that must
 * already exist (a caller that cannot honour it must fail), while `default` names a
 * domain that must be provisioned first.
 */
export type StackSelection =
  | { readonly kind: "explicit"; readonly source: "flag" | "env"; readonly stackId: string }
  | { readonly kind: "default"; readonly source: "default"; readonly domain: string };

/** Trim a possibly-absent value, so blank and missing are the same answer. */
function trimmedOrEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Resolve the Stack a Stack-scoped command should use.
 *
 * @param options - The command-line flag, when one was given, and the environment
 *   to read; `env` defaults to `process.env`.
 * @returns The explicit Stack the caller named, or the default domain.
 * @throws Never: an unconfigured workspace is a supported state, not an error.
 */
export function selectStack(
  options: { flag?: string | undefined; env?: NodeJS.ProcessEnv } = {},
): StackSelection {
  const flagged = trimmedOrEmpty(options.flag);
  if (flagged !== "") return { kind: "explicit", source: "flag", stackId: flagged };

  const environment = options.env ?? process.env;
  const configured = trimmedOrEmpty(environment[AKS_STACK_ID_ENV_VAR]);
  if (configured !== "") return { kind: "explicit", source: "env", stackId: configured };

  return { kind: "default", source: "default", domain: DEFAULT_STACK_DOMAIN };
}

/**
 * State which Stack a command used, and where that choice came from.
 *
 * The three wordings live in ONE place because several surfaces report them (the
 * CLI's active-Stack line, its diagnostics) and two copies of a sentence that must
 * agree eventually disagree.
 *
 * @param selection - A resolved selection.
 * @returns A single line naming the Stack and its origin.
 */
export function describeStackSelection(selection: StackSelection): string {
  if (selection.kind === "explicit") {
    const origin = selection.source === "flag" ? "--stack" : AKS_STACK_ID_ENV_VAR;
    return `Stack ${selection.stackId} (from ${origin})`;
  }
  return `Stack ${selection.domain} (from the default Stack)`;
}
