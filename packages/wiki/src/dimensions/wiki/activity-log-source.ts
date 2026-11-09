/**
 * @file src/dimensions/wiki/activity-log-source.ts
 * @description The journal seam: rows for a Stack, `log.md` for a project.
 *
 * ## Why a seam
 *
 * `appendLog` is called from three unrelated places (ingest, query, compile) and the
 * reader is the OKF bundle. Changing their signatures to move one storage decision
 * would touch all four to answer a question none of them asks. The decision lives
 * here: callers append an ENTRY, and this module decides where an entry lands.
 *
 * ## Why the selector hands back `undefined` instead of throwing
 *
 * A project with no Stack configured keeps writing `log.md`, byte for byte as before.
 * Returning `undefined` from the selector is what lets every caller stay identical,
 * and it is also what keeps this module out of the DTS graph for `compiler-cli`:
 * the rows path is opt-in through the environment, never through a type.
 */

import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import { appendJournalEntry, readJournalEntries, type JournalEntry } from "./activity-log-store.js";

/** The Stack this run is bound to, or undefined when the environment names none. */
function journalStackId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return stackId === "" ? undefined : stackId;
}

/**
 * Run `fn` with this Stack's journal, or with `undefined` when none is configured.
 *
 * A database failure is surfaced, never swallowed: `appendLog` is best-effort by
 * design, so the CALLER decides whether a failed append is a warning or an error.
 * Swallowing it here would hide a broken deployment behind a silent empty journal,
 * which is exactly the failure this migration is meant to remove.
 *
 * @param env - Environment naming the Stack.
 * @param fn - Receives the journal handle, or undefined for a file-backed project.
 * @returns Whatever `fn` returns.
 */
export async function withJournalSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: JournalSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = journalStackId(env);
  if (stackId === undefined) return fn(undefined);
  const handle = createDimensionsDatabase(env);
  try {
    return await fn({
      append: (entry) => appendJournalEntry(handle.db, stackId, entry),
      read: () => readJournalEntries(handle.db, stackId),
    });
  } finally {
    await handle.close();
  }
}

/** Append and read one Stack's journal entries. */
export interface JournalSource {
  /** Append one entry, returning the `seq` it was allocated. */
  append(entry: JournalEntry): Promise<number>;
  /** Every entry, in the order it was appended. */
  read(): Promise<JournalEntry[]>;
}

export type { JournalEntry };
