/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/list.ts
 * @description `GET /stacks/:stack_id/documents` — every document in a Stack.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { DOCUMENT_COLUMNS } from "./model.js";
import type { DocumentRow } from "./model.js";
import { parseStackId, sendApiError, sendValidationError } from "./params.js";
import { toDocumentResponse } from "./response.js";

/** Separated from its doc comment so the extraction pipeline above stays readable. */
/** `GET /stacks/:stack_id/documents` — every document in a Stack, newest first. */
export async function listDocuments(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const stackId = parseStackId(req.params["stack_id"]);
  if (!stackId.ok) {
    sendValidationError(res, stackId.failure);
    return;
  }

  const stacks = await tx.execute<{ id: string }>(
    sql`select id from stacks where id = ${stackId.value}`,
  );
  if (stacks.length === 0) {
    sendApiError(res, apiError(404, `Stack ${stackId.value} not found`));
    return;
  }

  // `order by ingested_at desc` is contractual: the list is newest-first, and an
  // unordered select would only look sorted until a row is inserted out of
  // sequence.
  const rows = await tx.execute<DocumentRow>(sql`
    select ${sql.raw(DOCUMENT_COLUMNS)}
    from stack_documents
    where stack_id = ${stackId.value}
    order by ingested_at desc
  `);

  res.json(rows.map(toDocumentResponse));
}
