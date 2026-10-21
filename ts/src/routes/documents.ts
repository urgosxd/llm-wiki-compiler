import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import {
  MAX_UPLOAD_BYTES,
  checkTruncation,
  computeSha256,
  getStoragePath,
  parseUploadForm,
  tryDecodeAsText,
  writeBytesToStorage,
} from "../core/files.js";
import type { UploadedFile, UploadFormResult } from "../core/files.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import { DocumentResponse } from "../dto.js";
import type { DocumentResponseDto } from "../dto.js";
import {
  apiError,
  pydanticUuid,
  toFastApiValidationError,
} from "../errors.js";
import type {
  ApiError,
  PydanticErrorDetail,
  ValidationFailure,
} from "../errors.js";

/**
 * The documents vertical — the TypeScript port of `app/routers/documents.py`.
 *
 * Four endpoints, on **two different path prefixes**, which is why this router
 * declares absolute paths and is mounted at the application root rather than at
 * a prefix:
 *
 *   POST   /stacks/{stack_id}/documents    upload a file        201
 *   GET    /stacks/{stack_id}/documents    list a Stack's docs  200
 *   GET    /documents/{doc_id}             fetch one record     200
 *   DELETE /documents/{doc_id}             delete record + file 204
 *
 * In Python the split is invisible: every route in `documents.py` declares its
 * own full path and `app.include_router(documents.router)` adds them flat. The
 * port keeps that shape instead of splitting into two routers, because the
 * method-resolution behaviour of the app (`http-contract.ts`) depends on the
 * flat declaration order: `PUT /documents/{uuid}` answers `405` with
 * `Allow: GET` on the oracle — one route's own method set, not the union — and
 * `DELETE /documents/{uuid}` must reach its handler rather than 405.
 *
 * ## Request order is contractual
 *
 * The oracle's observable order — measured, not inferred from reading the
 * Python — is:
 *
 * 1. **Form parsing** (Starlette, before any handler runs): a missing boundary,
 *    malformed delimiters, a part with no `name`, an oversized non-file part, or
 *    too many parts each answer `400`. `POST /stacks/not-a-uuid/documents` with
 *    no boundary is a `400`, not a `422`.
 * 2. **Request validation** (path parameter + `file` field), reported together
 *    with the path entry first. A bad `stack_id` plus a missing `file` answers
 *    `422` with both entries.
 * 3. **Stack existence** → `404`. An unknown stack with no `file` is the `422`
 *    from step 2, not a 404 — validation wins.
 * 4. **Upload limits** → `413` oversized, `400` empty, both *after* the stack
 *    check. An oversized upload to an unknown stack is a `404`.
 *
 * ## Uploads are idempotent by content hash
 *
 * The handler hashes the bytes and looks for `(stack_id, source_hash)` before
 * inserting. A repeat upload returns the *existing* record — same `id`, same
 * `filename` — with the same `201`. This is enforced as well by
 * `unique_hash_per_stack`, which the check simply short-circuits.
 *
 * The check-then-insert is racy, and preserved as such: two simultaneous uploads
 * of identical bytes can both pass the check, and the loser's insert then fails
 * on `unique_hash_per_stack` with a 23505 that surfaces as a 500 — which is what
 * the Python oracle does. Turning it into `on conflict do nothing` would change
 * an observable 500 into a silent success.
 */

/** Oracle column list, in oracle order. Mirrors the Python `select` lists. */
const DOCUMENT_COLUMNS =
  "id, stack_id, filename, size_bytes, content_type, source_hash, truncated, original_length, ingested_at, audit";

/** A `stack_documents` row as selected by {@link DOCUMENT_COLUMNS}. */
type DocumentRow = {
  id: string;
  stack_id: string;
  filename: string;
  size_bytes: number;
  content_type: string | null;
  source_hash: string;
  truncated: boolean;
  original_length: number | null;
  ingested_at: string;
  audit: Record<string, unknown> | null;
};

/**
 * Path-parameter validator for `:stack_id`.
 *
 * A one-key object whose key *is* the FastAPI parameter name, so the mapper
 * derives `loc: ["path", "stack_id"]` exactly. See `stacks.ts` for the full
 * reasoning; the same shape is used here for both parameters.
 */
const StackIdParams = z.object({ stack_id: pydanticUuid() });

/** Path-parameter validator for `:doc_id`. */
const DocIdParams = z.object({ doc_id: pydanticUuid() });

/** A validated path parameter, or the FastAPI 422 to send instead. */
type ParamParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Validates `:stack_id` the way FastAPI's `UUID` path parameter does. */
function parseStackId(raw: unknown): ParamParse {
  const parsed = StackIdParams.safeParse({ stack_id: raw });
  if (!parsed.success) {
    return {
      ok: false,
      failure: toFastApiValidationError(parsed.error, "path", { stack_id: raw }),
    };
  }
  return { ok: true, value: parsed.data.stack_id };
}

/** Validates `:doc_id` the way FastAPI's `UUID` path parameter does. */
function parseDocId(raw: unknown): ParamParse {
  const parsed = DocIdParams.safeParse({ doc_id: raw });
  if (!parsed.success) {
    return {
      ok: false,
      failure: toFastApiValidationError(parsed.error, "path", { doc_id: raw }),
    };
  }
  return { ok: true, value: parsed.data.doc_id };
}

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

/**
 * FastAPI's 422 body for the `file: UploadFile = File(...)` parameter.
 *
 * The two entries this endpoint can produce are *request-parsing* errors, not
 * model errors: FastAPI's multipart dependency either finds the field or does
 * not, and Pydantic never sees a model. They therefore have no counterpart in
 * the shared Zod DTOs, and there is no schema for `toFastApiValidationError` to
 * translate.
 *
 * The envelope is still the exported {@link ValidationFailure} type, and the
 * entry is typed as {@link PydanticErrorDetail}, so the wire shape cannot drift;
 * only the two literals below are stated here rather than derived. Both were
 * measured on the oracle:
 *
 *   no `file` part at all      -> missing, input null
 *   `file` sent as a string    -> value_error, input the string, ctx {error: {}}
 */
function fileFieldFailure(entry: PydanticErrorDetail): ValidationFailure {
  return { status: 422, body: { detail: [entry] } };
}

/** `file` field absent from the form: `missing`, with `input: null`. */
const MISSING_FILE: PydanticErrorDetail = {
  type: "missing",
  loc: ["body", "file"],
  msg: "Field required",
  input: null,
};

/**
 * `file` arrived as a plain field rather than an upload.
 *
 * FastAPI reports the class it received, and an empty `ctx.error` object — both
 * reproduced verbatim because both appear in the body.
 */
function expectedUploadFile(value: string): PydanticErrorDetail {
  return {
    type: "value_error",
    loc: ["body", "file"],
    msg: "Value error, Expected UploadFile, received: <class 'str'>",
    input: value,
    ctx: { error: {} },
  };
}

/**
 * Reads the complete request body.
 *
 * Multipart and urlencoded bodies arrive unparsed: `express.json()` only handles
 * JSON, and no multipart middleware is installed. A body that a previous
 * middleware already consumed (JSON) is reported as empty, which is what
 * Starlette's form parser would see — and for a JSON content type the form is
 * empty anyway, so the endpoint's verdict is unchanged.
 */
async function readRawBody(req: Request): Promise<Buffer> {
  if (req.readableEnded) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

/**
 * The `file` field of a successfully parsed form.
 *
 * Takes the already-narrowed result: Starlette's `invalid` verdict is answered
 * earlier with a 400, so only these two cases can reach validation.
 */
type FileField =
  | { readonly ok: true; readonly file: UploadedFile }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Collapses a non-invalid {@link UploadFormResult} into "a file, or the 422". */
function resolveFileField(
  form: Exclude<UploadFormResult, { kind: "invalid" }>,
): FileField {
  switch (form.kind) {
    case "file":
      return { ok: true, file: form.file };
    case "string":
      return { ok: false, failure: fileFieldFailure(expectedUploadFile(form.value)) };
    case "absent":
      return { ok: false, failure: fileFieldFailure(MISSING_FILE) };
  }
}

/** `DocumentResponse(**row)` — validates and fixes the key order in one step. */
function toDocumentResponse(row: DocumentRow): DocumentResponseDto {
  return DocumentResponse.parse(row);
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
async function uploadDocument(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  // Step 1: the form, before anything FastAPI-level. Errors here win over a bad
  // path parameter (measured: bad uuid + no boundary -> 400, not 422).
  const rawBody = await readRawBody(req);
  const form: UploadFormResult = parseUploadForm(rawBody, req.headers["content-type"]);
  if (form.kind === "invalid") {
    sendApiError(res, apiError(400, form.detail));
    return;
  }

  // Step 2: path parameter and `file` field, reported together with the path
  // entry first (measured on the oracle).
  const stackId = parseStackId(req.params["stack_id"]);
  const file = resolveFileField(form);

  if (!stackId.ok || !file.ok) {
    sendValidationError(res, {
      status: 422,
      body: {
        detail: [
          ...(stackId.ok ? [] : stackId.failure.body.detail),
          ...(file.ok ? [] : file.failure.body.detail),
        ],
      },
    });
    return;
  }

  // Step 3: the Stack must exist. Doing this first means a bogus stack_id never
  // pays for hashing a large upload.
  const stacks = await tx.execute<{ id: string }>(
    sql`select id from stacks where id = ${stackId.value}`,
  );
  if (stacks.length === 0) {
    sendApiError(res, apiError(404, `Stack ${stackId.value} not found`));
    return;
  }

  const data = file.file.data;

  // Step 4: upload bounds.
  if (data.length > MAX_UPLOAD_BYTES) {
    sendApiError(
      res,
      apiError(413, `File exceeds ${String(MAX_UPLOAD_BYTES)} byte limit`),
    );
    return;
  }
  if (data.length === 0) {
    sendApiError(res, apiError(400, "Uploaded file is empty"));
    return;
  }

  // Step 5: idempotency by content hash within the Stack.
  const sourceHash = computeSha256(data);
  const existing = await tx.execute<DocumentRow>(sql`
    select ${sql.raw(DOCUMENT_COLUMNS)}
    from stack_documents
    where stack_id = ${stackId.value} and source_hash = ${sourceHash}
  `);
  const existingRow = existing[0];
  if (existingRow !== undefined) {
    res.status(201).json(toDocumentResponse(existingRow));
    return;
  }

  // Step 6: the id is generated up front so the storage path is deterministic.
  const documentId = randomUUID();
  const filename = file.file.filename === "" ? "unknown" : file.file.filename;
  const storagePath = getStoragePath(stackId.value, documentId, filename);
  await writeBytesToStorage(data, storagePath);

  // Step 7: truncation applies only to content that decodes as UTF-8. Binary
  // files get checked downstream, after format-specific text extraction.
  const text = tryDecodeAsText(data);
  const truncation = text === null ? { truncated: false, originalLength: null } : checkTruncation(text);

  // Step 8: insert and return. `original_length` is null unless truncated.
  const rows = await tx.execute<DocumentRow>(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes,
      content_type, source_hash, truncated, original_length
    )
    values (
      ${documentId}, ${stackId.value}, ${filename}, ${storagePath}, ${data.length},
      ${file.file.contentType}, ${sourceHash}, ${truncation.truncated},
      ${truncation.originalLength}
    )
    returning ${sql.raw(DOCUMENT_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stack_documents returned no row");
  }

  res.status(201).json(toDocumentResponse(row));
}

/** `GET /stacks/:stack_id/documents` — every document in a Stack, newest first. */
async function listDocuments(
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

/** `GET /documents/:doc_id` — one record, or 404. Never returns file contents. */
async function getDocument(
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
async function deleteDocument(
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
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface DocumentsRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: DocumentsRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the documents router.
 *
 * Paths are absolute — the router must be mounted at the application root
 * (`app.use(createDocumentsRouter())`), not under `/stacks`, because the by-id
 * routes live under `/documents`. Auth is mounted here, mirroring
 * `dependencies=[Depends(require_api_key)]` on the Python router.
 */
export function createDocumentsRouter(
  deps: DocumentsRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/documents", deps.wrap(uploadDocument));
  router.get("/stacks/:stack_id/documents", deps.wrap(listDocuments));
  router.get("/documents/:doc_id", deps.wrap(getDocument));
  router.delete("/documents/:doc_id", deps.wrap(deleteDocument));

  return router;
}
