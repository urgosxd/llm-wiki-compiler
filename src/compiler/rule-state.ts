/**
 * Rule-extraction change-detection state (rule pipeline).
 *
 * `llmwiki rules extract` must decide which sources to (re)process on its own
 * cadence, independent of the concept compiler. If it reused `.llmwiki/state.json`
 * a source already compiled into pages would be considered "unchanged" and
 * yield zero rule candidates, while a source not yet compiled would be
 * re-extracted on every run. This module advances its own cursor, in
 * `wiki.rule_extractor_state`, keyed by Stack.
 *
 * The cursor is a ROW, not `.llmwiki/rule-state.json`. Two hosts sharing one Stack
 * must advance ONE cursor: a per-checkout file let each host re-extract the other's
 * work, and left the cursor behind whenever the run moved machines.
 *
 * The shape mirrors {@link WikiState} (so `detectChanges` can compare against
 * it directly), with a per-source output language for prompt invalidation.
 * `concepts` is always empty because rule extraction produces candidates, not pages.
 */

import type { WikiState, SourceState } from "../utils/types.js";
import { createDimensionsDatabase, resolveStackId } from "../dimensions/activation.js";
import { readRuleExtractorState, writeRuleExtractorState } from "../dimensions/wiki/marker-store.js";

/** A source advances only under the language that successfully processed it. */
interface RuleSourceState extends SourceState {
  /** Missing in older cursors; equivalent to the default language (empty string). */
  outputLanguage?: string;
}

/** Independent rule cursor, structurally compatible with source change detection. */
interface RuleState extends WikiState {
  sources: Record<string, RuleSourceState>;
}

/** A fresh, empty rule-extraction state. */
function emptyRuleState(): RuleState {
  return { version: 1, indexHash: "", sources: {} };
}

/**
 * Read `.llmwiki/rule-state.json`, returning an empty state when it is missing
 * or unreadable (a corrupt cursor must never block extraction — it just means
 * everything looks new).
 * @param root - Project root directory.
 */
export async function readRuleState(root: string): Promise<RuleState> {
  // The cursor lives where the rest of the compile state lives: a row. Two hosts
  // sharing one Stack must advance ONE cursor, or each re-extracts the other's work.
  void root;
  return await readRuleStateFromRows();
}

/**
 * Record that a source was processed by rule extraction at the given hash, so
 * a subsequent `rules extract` skips it until the source or language changes.
 * @param root - Project root directory.
 * @param sourceFile - Source filename within `sources/`.
 * @param entry - The source's hash, selected language and processing timestamp.
 */
export async function updateRuleSourceState(
  root: string,
  sourceFile: string,
  entry: RuleSourceState,
): Promise<void> {
  const state = await readRuleState(root);
  state.sources[sourceFile] = entry;
  await writeRuleStateFor(root, state);
}

/** Read the cursor from the Stack's row store. */
async function readRuleStateFromRows(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuleState> {
  const stackId = resolveStackId(env);
  const handle = createDimensionsDatabase(env);
  try {
    const stored = await readRuleExtractorState(handle.db, stackId);
    // A cursor that has never been written is EMPTY, not an error: it just means
    // everything looks new.
    return (stored ?? emptyRuleState()) as RuleState;
  } finally {
    await handle.close();
  }
}

/**
 * Persist the cursor to the backend this run will read from.
 *
 * Separate from {@link writeRuleState} so the two cannot disagree: a cursor written
 * to a file while reads come from rows would make every run re-extract everything.
 *
 * @param root - Project root, used by the file backend.
 * @param state - The cursor to persist.
 */
async function writeRuleStateFor(root: string, state: WikiState): Promise<void> {
  void root;
  const stackId = resolveStackId();
  const handle = createDimensionsDatabase();
  try {
    await writeRuleExtractorState(handle.db, stackId, state);
  } finally {
    await handle.close();
  }
}
