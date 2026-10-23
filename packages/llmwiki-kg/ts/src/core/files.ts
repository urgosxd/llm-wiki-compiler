/**
 * @file packages/llmwiki-kg/ts/src/core/files.ts
 * @description Upload handling — public surface.
 *
 * Upload handling: hashing, storage paths, truncation detection, and the
 * `multipart/form-data` parsing that FastAPI/Starlette does before the Python
 * handler body ever runs.
 *
 * TypeScript counterpart of `app/core/files.py`, plus the pieces of
 * `starlette.datastructures.FormData` / `python-multipart` that the documents
 * endpoints can observe on the wire.
 *
 * The module was split into `src/core/files/` to keep each file under the
 * project's size limits. It remains the single import site, so `documents.ts`,
 * `ingest.ts` and the tests import `core/files.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Limits + Starlette detail strings | `files/constants.ts` |
 * | Shapes a parsed form takes | `files/types.ts` |
 * | SHA-256 of an upload | `files/hashing.ts` |
 * | Storage paths + writing to disk | `files/storage.ts` |
 * | Truncation detection + UTF-8 probing | `files/truncation.ts` |
 * | Header/Content-Type parameter parsing | `files/headers.ts` |
 * | The `multipart/form-data` byte reader | `files/multipart.ts` |
 * | Media-type dispatch | `files/upload-form.ts` |
 *
 * ## Why the form parser lives here
 *
 * In Python the handler receives an already-parsed `UploadFile`; everything that
 * can go wrong while parsing — a missing boundary, malformed delimiters, an
 * oversized non-file part, an absent `file` field — is answered by Starlette
 * *before* the handler, with FastAPI's 400/422 envelopes. In Express nothing
 * parses multipart at all (no `multer`, no `busboy` in this project), so the port
 * has to reach the same verdicts itself.
 *
 * Writing the parser by hand rather than pulling a dependency was a measurement
 * decision: `formidable` and friends each bring their own error strings,
 * their own limits (a global byte cap rather than a per-part one), their own
 * preamble/line-ending tolerance, and their own casing rules for the media type.
 * Every one of those is observable, and every one of them differs from
 * `python-multipart`. The parser in `files/multipart.ts` reproduces the measured
 * behaviour instead of translating another library's.
 *
 * ## Buffered, not streamed
 *
 * The Python server reads the whole upload into memory (`await file.read()`),
 * and so does this: {@link parseUploadForm} takes a complete body. That is the
 * same memory characteristic as the oracle, deliberately — capping the buffer
 * earlier would change *which* error a large upload gets, because the size check
 * runs after the stack lookup (measured: an oversized upload to an unknown stack
 * answers 404, not 413).
 *
 * None of this touches Express, so it stays trivially unit-testable.
 */

export {
  MAX_EXTRACTION_CHARS,
  MAX_UPLOAD_BYTES,
  UPLOAD_DIR,
  MAX_PART_SIZE,
  MAX_FILE_PARTS,
  MAX_FIELD_PARTS,
  MULTIPART_DETAILS,
  partTooLargeDetail,
} from "./files/constants.js";

export type { UploadedFile, UploadFormResult } from "./files/types.js";

export { computeSha256 } from "./files/hashing.js";

export { getStoragePath, writeBytesToStorage } from "./files/storage.js";

export { checkTruncation, tryDecodeAsText } from "./files/truncation.js";
export type { TruncationCheck } from "./files/truncation.js";

export { parseUploadForm } from "./files/upload-form.js";
