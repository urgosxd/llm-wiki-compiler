/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/get.ts
 * @description `GET /stacks/:stack_id/documents/:doc_id` — one record, or 404.
 *
 * ## Why the Stack is in the path
 *
 * A document id alone cannot scope the read. `stack_documents.id` is unique, so the
 * query "worked", but it returned a row from ANY Stack — and it kept working only
 * because the connection ran as a superuser that bypasses row-level security. Under
 * the application role the same query returns zero rows, because no tenant context
 * was ever bound for the policy to evaluate.
 *
 * Naming the Stack does both jobs at once: it binds the tenant context and it lets
 * the query carry a `where stack_id = ...` of its own, so the read is correct with
 * or without RLS. The two are kept together on purpose — a filter without a binding
 * still leaks through any query path that forgets it, and a binding without a filter
 * trusts the policy alone.
 *
 * A document that exists under a DIFFERENT Stack is a 404, not a 403: answering
 * "forbidden" would confirm that the id exists somewhere, which is the same
 * cross-tenant disclosure in a different status code.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { DOCUMENT_COLUMNS } from "./model.js";
import type { DocumentRow } from "./model.js";
import { parseDocId, parseStackId, sendApiError, sendValidationError } from "./params.js";
import { toDocumentResponse } from "./response.js";

/**
 * `GET /stacks/:stack_id/documents/:doc_id` — one record, or 404.
 *
 * Never returns file contents.
 */
export async function getDocument(
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

  // The Stack must exist before its documents are looked for, so an unknown Stack
  // is a 404 naming the Stack rather than a 404 naming the document. Both answers
  // are 404 to the caller, but only one tells an operator which id was wrong.
  const stacks = await tx.execute<{ id: string }>(
    sql`select id from stacks where id = ${stackId.value}`,
  );
  if (stacks[0] === undefined) {
    sendApiError(res, apiError(404, `Stack '${stackId.value}' not found`));
    return;
  }

  const rows = await tx.execute<DocumentRow>(sql`
    select ${sql.raw(DOCUMENT_COLUMNS)}
    from stack_documents
    where id = ${docId.value} and stack_id = ${stackId.value}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Document ${docId.value} not found`));
    return;
  }

  res.json(toDocumentResponse(row));
}
