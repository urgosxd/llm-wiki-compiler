/**
 * @file src/cli/stack-option.ts
 * @description `--stack <id>` for the commands that read or write Stack-scoped data,
 * and the one line a command prints when it fell back to the default Stack.
 *
 * ## Why the flag writes the environment slot instead of a new parameter
 *
 * `AKS_STACK_ID` is the slot every layer beneath the CLI already reads, and exactly
 * one resolver turns it into a Stack (`selectStack`, then `resolveStackForCommand`).
 * A `--stack` parameter threaded through five command signatures and their services
 * would be a second channel carrying the same fact, and the two would disagree the
 * moment one path forgot it. So the flag follows the repository's flag→env adapter
 * convention (`src/utils/output-language.ts:49-53`): it writes the slot, and the
 * single resolver downstream reads the slot. `--provider` and `--lang` are the same
 * shape.
 *
 * ## Why an explicit selection is checked HERE and nowhere else
 *
 * An `AKS_STACK_ID` deployment trusts its variable: the operator set it once for the
 * process, and every run of that process means the same Stack. A `--stack` value is
 * different — it is typed per invocation, so a typo would silently write a caller's
 * documents into whatever Stack the default selection names. That is the one failure
 * this module refuses: a malformed value, or an id no Stack row carries, stops the
 * command before any work runs, naming the value it could not honour.
 *
 * Existence is probed against the connection the run itself will use, through the
 * same `createDimensionsDatabase` the dimensions open, and the handle is released
 * immediately — the check must not keep a pool alive for the command that follows.
 *
 * ## Why the default selection is ANNOUNCED here and not resolved here
 *
 * Provisioning the default Stack is the resolver's job (`ensureDefaultStack`, reached
 * through `resolveStackForCommand` on the write path). This module only reports which
 * selection the resolver will make, using `selectStack` — the same pure precedence
 * function, so there is no second opinion about what "nothing configured" means. The
 * line goes to STDERR because `--json` callers parse stdout and an advisory ahead of
 * the envelope breaks all of them; the announcement is for the human, not the pipe.
 */

import type { Command } from "commander";
import {
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
  type DimensionsDatabase,
} from "../dimensions/activation.js";
import { selectStack } from "../dimensions/stack-selection.js";
import { stackExists } from "../services/stacks/stack-store.js";

/** Help text of the option, identical on every command that accepts it. */
const DESCRIPTION = "Write to and read from this Stack instead of the one AKS_STACK_ID names.";

/** The line a command prints when it resolved the default Stack. */
const DEFAULT_STACK_NOTICE = "Using the default Stack (no --stack or AKS_STACK_ID configured).";

/**
 * A uuid in any version/format casing.
 *
 * Shape only: whether a Stack with that id EXISTS is a database question, asked
 * separately and only once the shape is known to be addressable at all.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Options shape contributed by {@link addStackOption}. */
export interface StackOption {
  stack?: string;
}

/** A `--stack` value this invocation cannot honour. */
class StackOptionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StackOptionError";
  }
}

/** Narrow a caught value to a message worth appending to ours. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Add the standard Stack selector to a Stack-scoped command. */
export function addStackOption(command: Command): Command {
  return command.option("--stack <id>", DESCRIPTION);
}

/**
 * Refuse a value that could not address a Stack row whatever the database holds.
 *
 * @param stackId - The trimmed value the caller passed.
 * @throws {StackOptionError} when it is not a uuid.
 */
function assertUuidShape(stackId: string): void {
  if (UUID_PATTERN.test(stackId)) return;
  throw new StackOptionError(
    `--stack value "${stackId}" is not a Stack id, which is a uuid. ` +
      `No Stack was selected and the default Stack was not used instead.`,
  );
}

/**
 * Ask the database whether a Stack row carries this id, reporting a failed question
 * as a refusal rather than as a driver error the caller cannot read.
 *
 * @param db - Handle the query runs on.
 * @param stackId - A uuid-shaped value.
 * @returns True when a row exists.
 * @throws {StackOptionError} when the check itself cannot reach the database.
 */
async function stackExistsIn(db: DimensionsDatabase["db"], stackId: string): Promise<boolean> {
  try {
    return await stackExists(db, stackId);
  } catch (error) {
    throw new StackOptionError(
      `--stack value "${stackId}" could not be checked against the database: ${messageOf(error)}.`,
      { cause: error },
    );
  }
}

/**
 * Refuse a `--stack` value that cannot become a Stack, before any work runs.
 *
 * @param stackId - The trimmed value the caller passed.
 * @throws {StackOptionError} when it is not a uuid, when no Stack carries that id,
 *   or when the check itself cannot reach the database.
 */
async function assertKnownStack(stackId: string): Promise<void> {
  assertUuidShape(stackId);
  // The probe reads the connection the run will use, with the flag already in the
  // slot: an operator's `AKS_DATABASE_URL` decides both, so the check cannot pass
  // against one database while the command writes to another.
  const handle = createDimensionsDatabase({ ...process.env, [AKS_STACK_ID_ENV_VAR]: stackId });
  try {
    if (await stackExistsIn(handle.db, stackId)) return;
    throw new StackOptionError(
      `--stack value "${stackId}" does not name an existing Stack. ` +
        `No Stack was selected and the default Stack was not used instead.`,
    );
  } finally {
    await handle.close();
  }
}

/**
 * Apply `--stack` for this run, or announce the default Stack when nothing chose one.
 *
 * Precedence is not re-implemented here: the flag is written into the one env slot and
 * `selectStack` decides the rest. Called once per invocation, before the command's work,
 * so the value is validated and the announcement is printed at most once.
 *
 * @param options - The Commander options object of a Stack-scoped command.
 * @throws {StackOptionError} when `--stack` names a Stack this run cannot honour.
 */
export async function applyStackOption(options: StackOption): Promise<void> {
  const flagged = options.stack?.trim() ?? "";
  if (flagged !== "") {
    await assertKnownStack(flagged);
    // Flag wins over the environment: the slot is OVERWRITTEN, not defaulted, so a
    // caller that passes `--stack` is never redirected by an inherited variable.
    process.env[AKS_STACK_ID_ENV_VAR] = flagged;
    return;
  }
  if (selectStack({ env: process.env }).kind === "explicit") return;
  console.error(DEFAULT_STACK_NOTICE);
}
