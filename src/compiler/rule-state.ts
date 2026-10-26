/**
 * Rule-extraction change-detection state (rule pipeline).
 *
 * `llmwiki rules extract` must decide which sources to (re)process on its own
 * cadence, independent of the concept compiler. If it reused `.llmwiki/state.json`
 * a source already compiled into pages would be considered "unchanged" and
 * yield zero rule candidates, while a source not yet compiled would be
 * re-extracted on every run. This module persists a parallel per-source hash
 * map in `.llmwiki/rule-state.json` so rule extraction advances its own cursor.
 *
 * The shape mirrors {@link WikiState} (so `detectChanges` can compare against
 * it directly), with a per-source output language for prompt invalidation.
 * `concepts` is always empty because rule extraction produces candidates, not pages.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { RULE_STATE_FILE } from "../utils/constants.js";
import { atomicWrite } from "../utils/markdown.js";
import type { WikiState, SourceState } from "../utils/types.js";
import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../dimensions/activation.js";
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
  // Rows first when a Stack is configured. The cursor must live where the rest of
  // the compile state lives, or two hosts would each advance their own and
  // re-extract each other's work.
  const viaRows = await readRuleStateFromRows();
  if (viaRows !== null) return viaRows;
  const filePath = path.join(root, RULE_STATE_FILE);
  if (!existsSync(filePath)) return emptyRuleState();
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as RuleState;
  } catch {
    return emptyRuleState();
  }
}

/**
 * Atomically write rule-state.json via the shared hardened {@link atomicWrite}
 * primitive (random O_EXCL temp + rename), so this cursor writer inherits the
 * same leaf-symlink write-escape defenses rather than carrying its own temp+rename.
 */
async function writeRuleState(root: string, state: WikiState): Promise<void> {
  const filePath = path.join(root, RULE_STATE_FILE);
  await atomicWrite(filePath, JSON.stringify(state, null, 2), { confineRoot: root });
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

/** Stack id this run is bound to, or undefined for the file backend. */
function stackIdOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return stackId === "" ? undefined : stackId;
}

/** Read the cursor from rows, or null when no Stack is configured. */
async function readRuleStateFromRows(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuleState | null> {
  const stackId = stackIdOf(env);
  if (stackId === undefined) return null;
  const handle = createDimensionsDatabase(env);
  try {
    const stored = await readRuleExtractorState(handle.db, stackId);
    // A cursor that has never been written is EMPTY, not an error: it just means
    // everything looks new, which is exactly what the file path answered for a
    // missing rule-state.json.
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
  const stackId = stackIdOf();
  if (stackId === undefined) {
    await writeRuleState(root, state);
    return;
  }
  const handle = createDimensionsDatabase();
  try {
    await writeRuleExtractorState(handle.db, stackId, state);
  } finally {
    await handle.close();
  }
}
