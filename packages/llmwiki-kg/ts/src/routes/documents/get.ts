/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/get.ts
 * @description `GET /documents/:doc_id` — one record, or 404.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { DOCUMENT_COLUMNS } from "./model.js";
import type { DocumentRow } from "./model.js";
import { parseDocId, sendApiError, sendValidationError } from "./params.js";
import { toDocumentResponse } from "./response.js";

/** `GET /documents/:doc_id` — one record, or 404. Never returns file contents. */
export async function getDocument(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const docId = parseDocId(req.params["doc_id"]);
  if (!docId.ok) {
    sendValidationError(res, docId.failure);
    return;
  }

  const rows = await tx.execute<DocumentRow>(sql`
    select ${sql.raw(DOCUMENT_COLUMNS)}
    from stack_documents
    where id = ${docId.value}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Document ${docId.value} not found`));
    return;
  }

  res.json(toDocumentResponse(row));
}
