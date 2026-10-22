/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/upload.ts
 * @description `POST /stacks/:stack_id/documents` — upload a file.
 *
 * Split out of `routes/documents.ts` as its own unit because it is the only
 * endpoint with a parsing pipeline: form parse, joint validation, Stack check,
 * size bounds, content-hash idempotency, storage write, truncation detection,
 * insert.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import {
  MAX_UPLOAD_BYTES,
  checkTruncation,
  computeSha256,
  getStoragePath,
  parseUploadForm,
  tryDecodeAsText,
  writeBytesToStorage,
} from "../../core/files.js";
import type { UploadFormResult, UploadedFile } from "../../core/files.js";
import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import type { ValidationFailure } from "../../errors.js";
import { DOCUMENT_COLUMNS } from "./model.js";
import type { DocumentRow } from "./model.js";
import {
  parseStackId,
  readRawBody,
  resolveFileField,
  sendApiError,
  sendValidationError,
} from "./params.js";
import { toDocumentResponse } from "./response.js";

/** An upload that passed every pre-storage check. */
interface PreparedUpload {
  readonly stackId: string;
  readonly file: UploadedFile;
}

/** A request refused before storage, in whichever envelope applies. */
type UploadRefusal =
  | { readonly status: number; readonly detail: string }
  | { readonly failure: ValidationFailure };

/** An existing record for the same bytes, or the new row after insert. */
type UploadOutcome = DocumentRow;

/**
 * Runs steps 1–4 of the documented pipeline: form parse, joint validation,
 * Stack existence, and the upload bounds.
 *
 * Nothing is written to storage until all four pass, so a 50 MB body is never
 * hashed for a stack that does not exist and an oversized upload never reaches
 * the filesystem.
 */
async function prepareUpload(req: Request, tx: Database): Promise<PreparedUpload | UploadRefusal> {
  // Step 1: the form, before anything FastAPI-level. Errors here win over a bad
  // path parameter (measured: bad uuid + no boundary -> 400, not 422).
  const rawBody = await readRawBody(req);
  const form: UploadFormResult = parseUploadForm(rawBody, req.headers["content-type"]);
  if (form.kind === "invalid") {
    return { status: 400, detail: form.detail };
  }

  // Step 2: path parameter and `file` field, reported together with the path
  // entry first (measured on the oracle).
  const stackId = parseStackId(req.params["stack_id"]);
  const file = resolveFileField(form);

  if (!stackId.ok || !file.ok) {
    return {
      failure: {
        status: 422,
        body: {
          detail: [
            ...(stackId.ok ? [] : stackId.failure.body.detail),
            ...(file.ok ? [] : file.failure.body.detail),
          ],
        },
      },
    };
  }

  const refusal = await checkStackAndBounds(tx, stackId.value, file.file);
  return refusal ?? { stackId: stackId.value, file: file.file };
}

/**
 * Step 3 and step 4: the Stack must exist, then the byte bounds apply.
 *
 * The Stack check comes first so a bogus `stack_id` never pays for hashing a
 * large upload; measured, an oversized upload to an unknown stack is a 404.
 */
async function checkStackAndBounds(
  tx: Database,
  stackId: string,
  file: UploadedFile,
): Promise<{ readonly status: number; readonly detail: string } | undefined> {
  const stacks = await tx.execute<{ id: string }>(
    sql`select id from stacks where id = ${stackId}`,
  );
  if (stacks.length === 0) {
    return { status: 404, detail: `Stack ${stackId} not found` };
  }

  const data = file.data;
  if (data.length > MAX_UPLOAD_BYTES) {
    return { status: 413, detail: `File exceeds ${String(MAX_UPLOAD_BYTES)} byte limit` };
  }
  if (data.length === 0) {
    return { status: 400, detail: "Uploaded file is empty" };
  }
  return undefined;
}

/** The deterministic identity of one stored upload. */
interface StoredFile {
  readonly documentId: string;
  readonly filename: string;
  readonly storagePath: string;
}

/** The existing record for these exact bytes in this Stack, if any. */
async function findExistingUpload(
  tx: Database,
  stackId: string,
  sourceHash: string,
): Promise<DocumentRow | undefined> {
  const rows = await tx.execute<DocumentRow>(sql`
    select ${sql.raw(DOCUMENT_COLUMNS)}
    from stack_documents
    where stack_id = ${stackId} and source_hash = ${sourceHash}
  `);
  return rows[0];
}

/**
 * Writes the bytes to `uploads/{stack_id}/{document_id}{ext}`.
 *
 * The id is generated up front so the storage path is deterministic before the
 * row exists.
 */
async function writeUploadFile(stackId: string, file: UploadedFile): Promise<StoredFile> {
  const documentId = randomUUID();
  const filename = file.filename === "" ? "unknown" : file.filename;
  const storagePath = getStoragePath(stackId, documentId, filename);
  await writeBytesToStorage(file.data, storagePath);
  return { documentId, filename, storagePath };
}

/** What the insert statement needs, once the bytes are on disk. */
interface DocumentInsert {
  readonly stackId: string;
  readonly file: UploadedFile;
  readonly sourceHash: string;
  readonly stored: StoredFile;
}

/** Inserts the row, detecting truncation for text-decodable content only. */
async function insertDocument(tx: Database, insert: DocumentInsert): Promise<DocumentRow> {
  const { stackId, file, sourceHash, stored } = insert;

  // Truncation applies only to content that decodes as UTF-8. Binary files get
  // checked downstream, after format-specific text extraction.
  const text = tryDecodeAsText(file.data);
  const truncation =
    text === null ? { truncated: false, originalLength: null } : checkTruncation(text);

  // `original_length` is null unless truncated.
  const rows = await tx.execute<DocumentRow>(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes,
      content_type, source_hash, truncated, original_length
    )
    values (
      ${stored.documentId}, ${stackId}, ${stored.filename}, ${stored.storagePath},
      ${file.data.length}, ${file.contentType}, ${sourceHash}, ${truncation.truncated},
      ${truncation.originalLength}
    )
    returning ${sql.raw(DOCUMENT_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stack_documents returned no row");
  }
  return row;
}

/**
 * Steps 5–8: idempotency by content hash, storage write, truncation, insert.
 *
 * A repeat upload of identical bytes returns the existing record rather than
 * storing anything, which is what makes uploads idempotent. The check-then-insert
 * is racy and preserved as such: two simultaneous uploads can both pass the
 * check, and the loser's insert fails on `unique_hash_per_stack` with a 23505
 * that surfaces as a 500 — the Python oracle's behaviour.
 */
async function storeUpload(tx: Database, prepared: PreparedUpload): Promise<UploadOutcome> {
  const { stackId, file } = prepared;
  const sourceHash = computeSha256(file.data);

  const existing = await findExistingUpload(tx, stackId, sourceHash);
  if (existing !== undefined) {
    return existing;
  }

  const stored = await writeUploadFile(stackId, file);
  return insertDocument(tx, { stackId, file, sourceHash, stored });
}
/**
 * `POST /stacks/:stack_id/documents` — upload a file, 201 with the record.
 *
 * Pipeline, in the oracle's order:
 *
 * 1. Parse the form (Starlette's 400s).
 * 2. Validate the path parameter and the `file` field together, path first.
 * 3. Verify the Stack exists — early 404, so a 50 MB body is not hashed for a
 *    stack that does not exist.
 * 4. Enforce the upload bounds: 413 above {@link MAX_UPLOAD_BYTES}, 400 when
 *    empty.
 * 5. Hash the content. If `(stack_id, source_hash)` already exists, return that
 *    record without storing anything — uploads are idempotent by content.
 * 6. Write the bytes to `uploads/{stack_id}/{document_id}{ext}`.
 * 7. Detect truncation for text-decodable files.
 * 8. Insert the row and return it.
 */
export async function uploadDocument(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const prepared = await prepareUpload(req, tx);
  if ("status" in prepared) {
    sendApiError(res, apiError(prepared.status, prepared.detail));
    return;
  }
  if ("failure" in prepared) {
    sendValidationError(res, prepared.failure);
    return;
  }

  const stored = await storeUpload(tx, prepared);
  res.status(201).json(toDocumentResponse(stored));
}