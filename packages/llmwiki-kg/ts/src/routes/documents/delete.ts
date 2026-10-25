/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/delete.ts
 * @description `DELETE /stacks/:stack_id/documents/:doc_id` — 204, removes the file.
 *
 * Split out of `routes/documents.ts` as its own unit because it is the only
 * endpoint that touches the filesystem on the way out, and its deletion order —
 * row first, file second — is the reason a failed `unlink` cannot leave the
 * record behind.
 *
 * ## Why the Stack is in the path, and why it is in the WHERE clause
 *
 * A DELETE scoped by document id alone reaches every Stack, and it did so
 * unnoticed because the connection ran as a superuser that bypasses row-level
 * security. Under the application role the same statement deletes nothing, which
 * is a safe failure but a silent one.
 *
 * The Stack is therefore part of the statement, not only of the tenant context.
 * That distinction matters more here than on a read: a read that loses its filter
 * returns extra rows, while a delete that loses its filter DESTROYS another
 * tenant's document. Filtering in the `where` clause means the row either belongs
 * to this Stack or is untouched, whatever the policy does.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { parseDocId, parseStackId, sendApiError, sendValidationError } from "./params.js";

/**
 * `DELETE /stacks/:stack_id/documents/:doc_id` — 204, removes the stored file.
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
  const stackId = parseStackId(req.params["stack_id"]);
  if (!stackId.ok) {
    sendValidationError(res, stackId.failure);
    return;
  }

  const docId = parseDocId(req.params["doc_id"]);
  if (!docId.ok) {
    sendValidationError(res, docId.failure);
    return;
  }

  // `stack_id` is part of the DELETE, not merely of the tenant binding: a
  // statement that loses this clause destroys another Stack's document, and no
  // policy can undo that.
  const rows = await tx.execute<{ storage_path: string }>(sql`
    delete from stack_documents
    where id = ${docId.value} and stack_id = ${stackId.value}
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
