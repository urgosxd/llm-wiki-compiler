/**
 * @file packages/llmwiki-kg/ts/src/core/files/storage.ts
 * @description Storage-path derivation and writing an upload to disk.
 *
 * Split out of `core/files.ts` as its own unit because it is the only part of
 * the upload core that touches the filesystem and the Python `PurePosixPath`
 * naming rules; keeping it apart leaves the rest of the core trivially pure.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { UPLOAD_DIR } from "./constants.js";

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/**
 * The final path component, as `PurePosixPath(filename).name` computes it.
 *
 * Python drops every empty and `.` component and keeps `..`, so `"a/."` is `"a"`
 * while `"a/.."` is `".."`. Reproduced because the stored extension — and
 * therefore `storage_path` — is derived from it.
 */
function finalComponent(filename: string): string {
  const parts = filename.split("/").filter((part) => part !== "" && part !== ".");
  return parts[parts.length - 1] ?? "";
}

/**
 * `PurePosixPath(filename).suffix` — the extension with its leading dot, or `""`.
 *
 * Python's rule is `i = name.rfind("."); return name[i:] if 0 < i < len(name) - 1
 * else ""`, which is why `.hidden`, `foo.`, `..` and `...` all have no suffix
 * while `.a.b` has `.b`. Reimplemented rather than approximated with
 * `path.extname`, whose edge cases differ (`path.extname(".hidden")` is `""` in
 * Node too, but `path.extname("a.")` is `"."` while Python's is `""`).
 */
function posixSuffix(filename: string): string {
  const name = finalComponent(filename);
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

/**
 * Builds the relative storage path for an uploaded document.
 *
 * Format: `uploads/{stack_id}/{document_id}{ext}`.
 *
 * The `document_id` in the filename guarantees uniqueness even when two real
 * files share a name; the original filename is preserved in the database column.
 * Measured in `stack_documents.storage_path`:
 * `uploads/20efd96a-…/d1dfd574-….txt`.
 */
export function getStoragePath(
  stackId: string,
  documentId: string,
  filename: string,
): string {
  return `${UPLOAD_DIR}/${stackId}/${documentId}${posixSuffix(filename)}`;
}

/**
 * Writes `data` to `storagePath`, creating parent directories as needed.
 *
 * Paths are relative to the working directory, exactly like the Python
 * `open(path, "wb")`. Overwrites an existing file, which is safe because
 * `document_id` is unique per upload.
 */
export async function writeBytesToStorage(
  data: Uint8Array,
  storagePath: string,
): Promise<void> {
  const path = resolve(process.cwd(), storagePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
