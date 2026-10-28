/**
 * @file test/fixtures/project-files.ts
 * @description Helpers for asserting exact project file trees in tests.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Return every file under a project root as sorted, forward-slash relative paths. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else pushIfFileEntry(files, root, full, entry);
    }
  }

  await walk(root);
  return files.sort();
}

/**
 * Record a non-directory entry, when it is a file or a symlink.
 *
 * Symlinks are included on purpose: the caller is checking what a project CONTAINS,
 * and a link that escapes the root is a finding the caller must be able to see rather
 * than one this scan should hide.
 *
 * @param files - Accumulator, mutated in place.
 * @param root - Root the emitted path is relative to.
 * @param full - Absolute path of the entry.
 * @param entry - The directory entry, which decides whether it counts.
 */
function pushIfFileEntry(
  files: string[],
  root: string,
  full: string,
  entry: { readonly isFile: () => boolean; readonly isSymbolicLink: () => boolean },
): void {
  if (!entry.isFile() && !entry.isSymbolicLink()) return;
  files.push(path.relative(root, full).split(path.sep).join("/"));
}
