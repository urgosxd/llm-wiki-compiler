/**
 * @file src/dimensions/stack-selection.ts
 * @description Which Stack a command works on, and where that choice came from.
 *
 * ## Why this is a resolved VALUE and not an environment read
 *
 * The Stack used to be read inline from `AKS_STACK_ID` at each seam that needed
 * one, so "which Stack am I on" had as many answers as it had readers. Selection
 * now resolves ONCE, into a value that says both what was chosen and why, and every
 * consumer downstream formats or defers to that one answer.
 *
 * Precedence, highest first:
 *
 *   1. `--stack <id>` on the command line.
 *   2. `AKS_STACK_ID`.
 *   3. Nothing: the run selected NO Stack.
 *
 * ## Why there is no third answer to invent
 *
 * Step 3 used to be a deterministic default Stack, materialized on first use. That
 * is gone by decision (S1 of `odd/tasks/stack-authority-per-request.md`): no Stack
 * is created implicitly, so a Stack exists because its owner created it over HTTP
 * or declared it explicitly at boot. Selection therefore has no row to name and
 * says so — `{ kind: "none" }` — instead of naming a domain nobody created.
 *
 * Absence is still not an error HERE: steps 1 and 2 treat a blank or whitespace-only
 * value as ABSENT, because a shell that expands `--stack "$UNSET"` to the empty
 * string meant nothing by it. Turning "nothing named" into a refusal by name is the
 * resolver's job, and it happens once, in `services/stacks/resolve-stack.ts`.
 *
 * ## What this module deliberately does NOT do
 *
 * It resolves nothing against the database and provisions nothing. Keeping selection
 * pure is what lets it be tested without a connection.
 */

import { AKS_STACK_ID_ENV_VAR } from "./activation.js";

/** Where a resolved Stack came from. */
export type StackSelectionSource = "flag" | "env";

/**
 * A Stack a command will use.
 *
 * The two shapes are kept apart rather than collapsed into a nullable id because
 * they mean different things downstream: an `explicit` id names a Stack the caller
 * asked for out loud, while `none` says the caller asked for no Stack at all and
 * this build will not invent one.
 */
export type StackSelection =
  | { readonly kind: "explicit"; readonly source: StackSelectionSource; readonly stackId: string }
  | { readonly kind: "none" };

/** Trim a possibly-absent value, so blank and missing are the same answer. */
function trimmedOrEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Resolve the Stack a Stack-scoped command should use.
 *
 * @param options - The command-line flag, when one was given, and the environment
 *   to read; `env` defaults to `process.env`.
 * @returns The Stack the caller named, or `{ kind: "none" }` when it named none.
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

  return { kind: "none" };
}

/**
 * State which Stack a command used, and where that choice came from.
 *
 * The wordings live in ONE place because several surfaces report them (the CLI's
 * active-Stack line, its diagnostics) and two copies of a sentence that must agree
 * eventually disagree.
 *
 * @param selection - A resolved selection.
 * @returns A single line naming the Stack and its origin, or saying none was named.
 */
export function describeStackSelection(selection: StackSelection): string {
  if (selection.kind === "explicit") {
    const origin = selection.source === "flag" ? "--stack" : AKS_STACK_ID_ENV_VAR;
    return `Stack ${selection.stackId} (from ${origin})`;
  }
  return `No Stack named (no --stack and no ${AKS_STACK_ID_ENV_VAR})`;
}
