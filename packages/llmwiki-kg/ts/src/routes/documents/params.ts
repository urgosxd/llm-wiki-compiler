/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/params.ts
 * @description Path-parameter validation and the multipart `file` field's 422s.
 *
 * Split out of `routes/documents.ts` as its own unit because the `file:
 * UploadFile = File(...)` envelope has no counterpart in the shared Zod DTOs —
 * FastAPI's multipart dependency either finds the field or does not, and
 * Pydantic never sees a model — so both literals are stated here rather than
 * derived.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import {
  pydanticUuid,
  toFastApiValidationError,
} from "../../errors.js";
import type {
  ApiError,
  PydanticErrorDetail,
  ValidationFailure,
} from "../../errors.js";
import type { UploadFormResult, UploadedFile } from "../../core/files.js";

/**
 * Path-parameter validator for `:stack_id`.
 *
 * A one-key object whose key *is* the FastAPI parameter name, so the mapper
 * derives `loc: ["path", "stack_id"]` exactly. See `stacks.ts` for the full
 * reasoning; the same shape is used here for both parameters.
 */
export const StackIdParams = z.object({ stack_id: pydanticUuid() });

/** Path-parameter validator for `:doc_id`. */
export const DocIdParams = z.object({ doc_id: pydanticUuid() });

/** A validated path parameter, or the FastAPI 422 to send instead. */
export type ParamParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Validates `:stack_id` the way FastAPI's `UUID` path parameter does. */
export function parseStackId(raw: unknown): ParamParse {
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
export function parseDocId(raw: unknown): ParamParse {
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
export function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
export function sendValidationError(res: Response, failure: ValidationFailure): void {
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
export function fileFieldFailure(entry: PydanticErrorDetail): ValidationFailure {
  return { status: 422, body: { detail: [entry] } };
}

/** `file` field absent from the form: `missing`, with `input: null`. */
export const MISSING_FILE: PydanticErrorDetail = {
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
export function expectedUploadFile(value: string): PydanticErrorDetail {
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
export async function readRawBody(req: Request): Promise<Buffer> {
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
export type FileField =
  | { readonly ok: true; readonly file: UploadedFile }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Collapses a non-invalid {@link UploadFormResult} into "a file, or the 422". */
export function resolveFileField(
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
