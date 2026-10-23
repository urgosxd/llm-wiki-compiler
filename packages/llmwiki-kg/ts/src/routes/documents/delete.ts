/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/delete.ts
 * @description `DELETE /documents/:doc_id` — 204, and removes the stored file.
 *
 * Split out of `routes/documents.ts` as its own unit because it is the only
 * endpoint that touches the filesystem on the way out, and its deletion order —
 * row first, file second — is the reason a failed `unlink` cannot leave the
 * record behind.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { parseDocId, sendApiError, sendValidationError } from "./params.js";

/**
 * `DELETE /documents/:doc_id` — 204, and removes the stored file.
 *
 * The row is deleted first and the file afterwards, matching the Python order:
 * a failed `unlink` therefore cannot leave the record behind. A file that is
 * already gone is silent, because `storage_path` is not guaranteed to point at an
 * existing file (a crashed upload leaves the row without bytes).
 *
 * Chunk and `entity_source_documents` rows cascade from the foreign keys, so
 * nothing else has to be deleted here.
 */
export async function deleteDocument(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const docId = parseDocId(req.params["doc_id"]);
  if (!docId.ok) {
    sendValidationError(res, docId.failure);
    return;
  }

  const rows = await tx.execute<{ storage_path: string }>(sql`
    delete from stack_documents
    where id = ${docId.value}
    returning storage_path
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Document ${docId.value} not found`));
    return;
  }

  try {
    await unlink(resolve(process.cwd(), row.storage_path));
  } catch (error) {
    // `Path.exists() / unlink()` in Python: absent file is not an error.
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  // `.end()` with no payload: the oracle answers 204 with a zero-length body.
  res.status(204).end();
}

/** True when `error` is ENOENT, without widening the catch to everything. */
export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
