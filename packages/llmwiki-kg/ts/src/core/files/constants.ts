/**
 * @file packages/llmwiki-kg/ts/src/core/files/constants.ts
 * @description Upload limits and the exact Starlette multipart detail strings.
 *
 * Split out of `core/files.ts` as its own unit because these values are the
 * measured contract, not tunables: every limit matches a Starlette default and
 * every detail string was observed on the Python oracle, so they are read by the
 * form parser and asserted by the tests independently of the parsing logic.
 */

// ---------------------------------------------------------------------------
// Constants — `app/core/constants.py` plus Starlette's form defaults
// ---------------------------------------------------------------------------

/**
 * `MAX_EXTRACTION_CHARS = 500_000`.
 *
 * Documents larger than this are still stored in full on disk; the extraction
 * pipeline truncates the text it sends to the LLM.
 */
export const MAX_EXTRACTION_CHARS = 500_000;

/** `MAX_UPLOAD_BYTES = 50 * 1024 * 1024` — hard bound on a single upload. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** `UPLOAD_DIR = "uploads"`, relative to the server's working directory. */
export const UPLOAD_DIR = "uploads";

/**
 * Starlette's `MultiPartParser.max_part_size`, its default (1024 * 1024).
 *
 * Applied **only to non-file parts**. Measured: a 1 MiB text field passes, one
 * byte more answers `400 Part exceeded maximum size of 1024KB.`, while a 50 MB
 * *file* part is accepted.
 */
export const MAX_PART_SIZE = 1024 * 1024;

/** Starlette's `max_files` default. Measured: 1000 files pass, 1001 do not. */
export const MAX_FILE_PARTS = 1000;

/** Starlette's `max_fields` default. Measured: 1000 fields pass, 1001 do not. */
export const MAX_FIELD_PARTS = 1000;

/**
 * The exact `detail` strings Starlette answers with. Each one was measured on
 * the oracle; they are part of the contract, not diagnostics.
 */
export const MULTIPART_DETAILS = {
  missingBoundary: "Missing boundary in multipart.",
  invalid: "Invalid multipart data.",
  nameRequired:
    'The Content-Disposition header field "name" must be provided.',
  tooManyFiles: `Too many files. Maximum number of files is ${String(MAX_FILE_PARTS)}.`,
  tooManyFields: `Too many fields. Maximum number of fields is ${String(MAX_FIELD_PARTS)}.`,
} as const;

/**
 * `Part exceeded maximum size of 1024KB.`
 *
 * Starlette builds this from `int(max_part_size / 1024)`, so the number is
 * derived rather than hard-coded.
 */
export function partTooLargeDetail(): string {
  return `Part exceeded maximum size of ${String(Math.trunc(MAX_PART_SIZE / 1024))}KB.`;
}

/** Media type of a multipart form, compared verbatim (case-sensitive). */
export const MULTIPART_MEDIA_TYPE = "multipart/form-data";

/** Media type of a urlencoded form, compared verbatim (case-sensitive). */
export const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";
