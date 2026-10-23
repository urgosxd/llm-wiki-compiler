/**
 * @file packages/llmwiki-kg/ts/src/core/files/upload-form.ts
 * @description Media-type dispatch: what FastAPI would hand the handler as a form.
 *
 * Split out of `core/files.ts` as its own unit because it is the only place that
 * compares `Content-Type` — and it compares it verbatim, case-sensitively, which
 * is a Starlette behaviour worth isolating from the byte-level parsers it picks
 * between.
 */

import {
  MULTIPART_DETAILS,
  MULTIPART_MEDIA_TYPE,
  URLENCODED_MEDIA_TYPE,
} from "./constants.js";
import { parseHeaderValue } from "./headers.js";
import { parseMultipartForm } from "./multipart.js";
import { FILE_FIELD } from "./types.js";
import type { UploadFormResult } from "./types.js";

/**
 * Parses an `application/x-www-form-urlencoded` body, where `file` can only ever
 * be a string.
 *
 * Measured: `file=abc` answers `422 value_error, Expected UploadFile, received:
 * <class 'str'>` with `input: "abc"`, and a form without `file` answers
 * `422 missing`.
 */
function parseUrlEncodedForm(body: Uint8Array): UploadFormResult {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
  const params = new URLSearchParams(text);
  const value = params.get(FILE_FIELD);
  return value === null ? { kind: "absent" } : { kind: "string", value };
}

/**
 * Reproduces the form FastAPI would hand the handler for this request.
 *
 * Dispatch mirrors Starlette's `Request._get_form`: the media type is compared
 * **verbatim**, so `MULTIPART/FORM-DATA` is not multipart at all (measured: it
 * answers `422 missing`), and any other content type — JSON, text, absent —
 * yields an empty form.
 *
 * @param body the complete request body.
 * @param contentType the raw `Content-Type` header, or `undefined` when absent.
 */
export function parseUploadForm(
  body: Uint8Array,
  contentType: string | undefined,
): UploadFormResult {
  if (contentType === undefined) {
    return { kind: "absent" };
  }

  const { value: mediaType, params } = parseHeaderValue(contentType);

  if (mediaType === MULTIPART_MEDIA_TYPE) {
    const boundary = params.get("boundary");
    if (boundary === undefined) {
      return { kind: "invalid", detail: MULTIPART_DETAILS.missingBoundary };
    }
    return parseMultipartForm(Buffer.from(body), boundary);
  }

  if (mediaType === URLENCODED_MEDIA_TYPE) {
    return parseUrlEncodedForm(body);
  }

  return { kind: "absent" };
}
