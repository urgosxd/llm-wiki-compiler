/**
 * Source file hashing for change detection.
 * Computes SHA-256 hashes of source files and compares them against
 * previously stored state to determine which files need recompilation.
 * This enables incremental compilation — only changed or new sources
 * are sent through the LLM pipeline.
 */

import { createHash } from "node:crypto";
import { readFile } from "fs/promises";
import path from "path";
import { SOURCES_DIR } from "../utils/constants.js";
import type { WikiState, SourceChange } from "../utils/types.js";
import { listSelectedSourceFiles } from "../sources/scan.js";
import { isSourceSelected, loadSourceSelection, type SourceSelection } from "../sources/selection.js";

/**
 * Read a file and compute its SHA-256 hash.
 * @param filePath - Absolute path to the file to hash.
 * @returns Hex-encoded SHA-256 digest of the file contents.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Scan the sources/ directory and compare file hashes against previous state
 * to identify new, changed, unchanged, and deleted source files.
 * @param root - Project root directory containing the sources/ folder.
 * @param prevState - The previously persisted WikiState to compare against.
 * @returns Array of SourceChange entries describing each file's status.
 */
export async function detectChanges(
  root: string,
  prevState: WikiState,
  source?: ChangeDetectionSource,
): Promise<SourceChange[]> {
  const selection = await loadSourceSelection(root);
  // Rows are authoritative when a Stack is configured. The directory is consulted
  // only when it is not, so a project that never opted into the backend keeps
  // compiling exactly as before.
  const current: Array<{ key: string; hash?: string }> = source === undefined
    ? await listSelectedSourceFiles(root, selection).then((files) => files.map((file) => ({ key: file })))
    : (await source.list()).map((doc) => ({ key: doc.sourceIdentity, hash: doc.contentHash }));
  const changes: SourceChange[] = [];

  for (const entry of current) {
    const status = entry.hash === undefined
      ? await classifyFile(root, entry.key, prevState)
      : classifyHashedDocument(entry.key, entry.hash, prevState);
    changes.push({ file: entry.key, status });
  }

  const currentKeys = current.map((entry) => entry.key);
  // Selection is a policy over DIRECTORY paths (`--exclude`, recursion), so it can
  // only judge a corpus whose keys are paths. A source identity is not one: an
  // identity like `https://host/1` contains a slash yet sits in no subdirectory,
  // and applying the rule would mark every URL as deselected -- silently retiring
  // documents that were merely deleted.
  const deletedChanges = source === undefined
    ? findDeletedFiles(currentKeys, prevState, selection)
    : findDeletedDocuments(currentKeys, prevState);
  changes.push(...deletedChanges);

  return changes;
}

/**
 * Where change detection reads the corpus from.
 *
 * The file path and the row path answer the same question, and one of them has to
 * be authoritative. Threading the choice keeps it visible at the call site instead
 * of hiding a default that silently reads the wrong place -- the same seam shape
 * the embedding loaders use.
 */
export interface ChangeDetectionSource {
  /**
   * Every document in the Stack, with the hash already stored beside it.
   *
   * The hash travels with the document because that is what makes the comparison
   * trustworthy: `content_hash` is written by the same transaction that writes
   * `content`, so it cannot describe a version of the bytes that never existed.
   */
  list(): Promise<Array<{ sourceIdentity: string; contentHash: string }>>;
}

/**
 * Classify a document whose hash came from the table.
 *
 * Same four outcomes as the file path, and the same reasoning: an unknown identity
 * is new, a different hash is changed, and a matching hash is unchanged. Kept
 * separate from {@link classifyFile} rather than folded into it because the file
 * version must still read and hash the bytes, which a row does not need.
 *
 * @param sourceIdentity - Unique identity of the document.
 * @param hash - Stored hash of its current content.
 * @param prevState - Previous compilation state, keyed by identity.
 * @returns The change status for this document.
 */
function classifyHashedDocument(
  sourceIdentity: string,
  hash: string,
  prevState: WikiState,
): SourceChange["status"] {
  const prev = prevState.sources[sourceIdentity];
  if (!prev) return "new";
  if (prev.hash !== hash) return "changed";
  return "unchanged";
}

/**
 * Classify a single source file as new, changed, or unchanged.
 * @param root - Project root directory.
 * @param file - Filename within sources/.
 * @param prevState - Previous compilation state.
 * @returns The change status for this file.
 */
async function classifyFile(
  root: string,
  file: string,
  prevState: WikiState,
): Promise<SourceChange["status"]> {
  const filePath = path.join(root, SOURCES_DIR, file);
  const hash = await hashFile(filePath);
  const prev = prevState.sources[file];

  if (!prev) return "new";
  if (prev.hash !== hash) return "changed";
  return "unchanged";
}

/**
 * Retire documents that no longer exist, when keys are identities.
 *
 * No `deselected` reason is possible here: selection policy filters a directory
 * tree, and rows have no tree to filter. A missing row is a deletion, full stop.
 *
 * @param currentIdentities - Identities the Stack currently holds.
 * @param prevState - Previous compilation state, keyed by identity.
 * @returns Deletion entries for every compiled document the Stack no longer has.
 */
function findDeletedDocuments(currentIdentities: string[], prevState: WikiState): SourceChange[] {
  const currentSet = new Set(currentIdentities);
  return Object.keys(prevState.sources)
    .filter((identity) => !currentSet.has(identity))
    .map((identity) => ({ file: identity, status: "deleted" as const }));
}

/**
 * Retire prior source contributions that disappeared or are no longer selected.
 * @param currentFiles - Selected regular Markdown files currently on disk.
 * @param prevState - Previous compilation state.
 * @returns Array of SourceChange entries for deleted files.
 */
function findDeletedFiles(
  currentFiles: string[],
  prevState: WikiState,
  selection: SourceSelection,
): SourceChange[] {
  const currentSet = new Set(currentFiles);
  return Object.keys(prevState.sources)
    .filter((file) => !currentSet.has(file))
    .map((file) => ({ file, status: "deleted" as const,
      ...(!isSourceSelected(file, selection) ? { reason: "deselected" as const } : {}),
    }));
}
