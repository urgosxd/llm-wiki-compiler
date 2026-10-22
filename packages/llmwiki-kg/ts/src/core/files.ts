import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Upload handling: hashing, storage paths, truncation detection, and the
 * `multipart/form-data` parsing that FastAPI/Starlette does before the Python
 * handler body ever runs.
 *
 * TypeScript counterpart of `app/core/files.py`, plus the pieces of
 * `starlette.datastructures.FormData` / `python-multipart` that the documents
 * endpoints can observe on the wire.
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
 * `python-multipart`. The parser below reproduces the measured behaviour instead
 * of translating another library's.
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
const MULTIPART_MEDIA_TYPE = "multipart/form-data";

/** Media type of a urlencoded form, compared verbatim (case-sensitive). */
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Hex SHA-256 digest of `data`.
 *
 * Python: `hashlib.sha256(data).hexdigest()`. The digest is over the raw bytes,
 * so it is what makes uploads idempotent (`unique_hash_per_stack`).
 */
export function computeSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/**
 * The final path component, as `PurePosixPath(filename).name` computes it.
 *
 * Python drops every empty and `.` component and keeps `..`, so `"a/."` is `"a"`
 * while `"a/.."` is `".."`. Reproduced because the stored extension — and
 * therefore `storage_path` — is derived from it.
 */
function finalComponent(filename: string): string {
  const parts = filename.split("/").filter((part) => part !== "" && part !== ".");
  return parts[parts.length - 1] ?? "";
}

/**
 * `PurePosixPath(filename).suffix` — the extension with its leading dot, or `""`.
 *
 * Python's rule is `i = name.rfind("."); return name[i:] if 0 < i < len(name) - 1
 * else ""`, which is why `.hidden`, `foo.`, `..` and `...` all have no suffix
 * while `.a.b` has `.b`. Reimplemented rather than approximated with
 * `path.extname`, whose edge cases differ (`path.extname(".hidden")` is `""` in
 * Node too, but `path.extname("a.")` is `"."` while Python's is `""`).
 */
function posixSuffix(filename: string): string {
  const name = finalComponent(filename);
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

/**
 * Builds the relative storage path for an uploaded document.
 *
 * Format: `uploads/{stack_id}/{document_id}{ext}`.
 *
 * The `document_id` in the filename guarantees uniqueness even when two real
 * files share a name; the original filename is preserved in the database column.
 * Measured in `stack_documents.storage_path`:
 * `uploads/20efd96a-…/d1dfd574-….txt`.
 */
export function getStoragePath(
  stackId: string,
  documentId: string,
  filename: string,
): string {
  return `${UPLOAD_DIR}/${stackId}/${documentId}${posixSuffix(filename)}`;
}

/**
 * Writes `data` to `storagePath`, creating parent directories as needed.
 *
 * Paths are relative to the working directory, exactly like the Python
 * `open(path, "wb")`. Overwrites an existing file, which is safe because
 * `document_id` is unique per upload.
 */
export async function writeBytesToStorage(
  data: Uint8Array,
  storagePath: string,
): Promise<void> {
  const path = resolve(process.cwd(), storagePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

// ---------------------------------------------------------------------------
// Truncation detection
// ---------------------------------------------------------------------------

/** Result of a truncation check; `originalLength` is null unless truncated. */
export interface TruncationCheck {
  readonly truncated: boolean;
  readonly originalLength: number | null;
}

/**
 * Counts Python `len()` code points rather than UTF-16 code units.
 *
 * `String.prototype.length` counts surrogate pairs as two, so 500001 emoji would
 * read as 1000002 units and be reported as a 1000002-character document.
 * Measured: the oracle reports `original_length: 500001` for exactly that file.
 */
function codePointLength(text: string): number {
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
  }
  return count;
}

/**
 * Returns whether `textContent` exceeds the extraction limit, and its length.
 *
 * `truncated: true` means the text exceeds {@link MAX_EXTRACTION_CHARS} and
 * would be cut at extraction time. Storing the full text and only *detecting*
 * truncation here is the Python behaviour: the cutting happens downstream.
 */
export function checkTruncation(textContent: string): TruncationCheck {
  const length = codePointLength(textContent);
  if (length > MAX_EXTRACTION_CHARS) {
    return { truncated: true, originalLength: length };
  }
  return { truncated: false, originalLength: null };
}

/**
 * Decodes `data` as UTF-8, or returns `null` when it is not valid UTF-8.
 *
 * Decides whether truncation detection applies: binary files (PDFs, images) are
 * skipped at upload time and get truncation-checked later, after format-specific
 * text extraction.
 *
 * `fatal: true` is what makes this match Python's `UnicodeDecodeError` instead of
 * silently substituting U+FFFD. `ignoreBOM: true` keeps a leading BOM as a
 * character, because Python's `bytes.decode("utf-8")` does — without it the BOM
 * would be stripped and the counted length would be off by one.
 */
export function tryDecodeAsText(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

/** A file part, as FastAPI's `UploadFile` presents it to the handler. */
export interface UploadedFile {
  /**
   * The filename from the part's `Content-Disposition`, verbatim — including an
   * empty string, which the handler turns into `"unknown"`.
   */
  readonly filename: string;
  /** The part's own `Content-Type`, or `null` when the part had none. */
  readonly contentType: string | null;
  /** The part's bytes, exactly as sent. */
  readonly data: Uint8Array;
}

/**
 * What the `file` field turned out to be.
 *
 * FastAPI distinguishes all four, and so must the port: `absent` and `string`
 * are 422s built by the route, `invalid` is a 400 with Starlette's detail, and
 * `file` is the only shape that reaches the handler.
 */
export type UploadFormResult =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly file: UploadedFile }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "invalid"; readonly detail: string };

/** The name this router cares about; every other part is counted and ignored. */
const FILE_FIELD = "file";

const CRLF = Buffer.from("\r\n", "latin1");
const DASH = 0x2d;

/** A header value split into its leading value and its parameters. */
interface ParsedHeaderValue {
  readonly value: string;
  /** Parameter names lowercased, values unquoted. */
  readonly params: ReadonlyMap<string, string>;
}

/**
 * Splits `key=value; key="quoted value"` into a map.
 *
 * Handles quoted values (with backslash escapes) and unquoted values, which is
 * what `parse_options_header` accepts. Semicolons inside quotes are not
 * separators: measured, `Content-Type: text/plain; charset=utf-8` arrives intact.
 */
function parseParameters(source: string): Map<string, string> {
  const params = new Map<string, string>();
  let index = 0;

  while (index < source.length) {
    while (index < source.length && (source[index] === ";" || source[index] === " ")) {
      index += 1;
    }
    const keyStart = index;
    while (index < source.length && source[index] !== "=" && source[index] !== ";") {
      index += 1;
    }
    if (index >= source.length || source[index] !== "=") {
      // A bare token with no `=`; run past it.
      while (index < source.length && source[index] !== ";") {
        index += 1;
      }
      continue;
    }
    const key = source.slice(keyStart, index).trim().toLowerCase();
    index += 1;

    let value: string;
    if (source[index] === '"') {
      index += 1;
      let collected = "";
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          index += 1;
        }
        collected += source[index] ?? "";
        index += 1;
      }
      // Skip the closing quote.
      index += 1;
      value = collected;
    } else {
      const valueStart = index;
      while (index < source.length && source[index] !== ";") {
        index += 1;
      }
      value = source.slice(valueStart, index).trim();
    }

    if (key !== "") {
      params.set(key, value);
    }
  }

  return params;
}

/** Splits one header (or `Content-Type`) value into its value and parameters. */
function parseHeaderValue(raw: string): ParsedHeaderValue {
  const separator = raw.indexOf(";");
  if (separator < 0) {
    return { value: raw.trim(), params: new Map() };
  }
  return {
    value: raw.slice(0, separator).trim(),
    params: parseParameters(raw.slice(separator + 1)),
  };
}

/** One parsed part, before the `file` field is picked out. */
type PartEntry =
  | { readonly kind: "file"; readonly file: UploadedFile }
  | { readonly kind: "string"; readonly value: string };

/** A parsed header block: header names lowercased, values trimmed. */
type HeaderBlock = Map<string, string>;

/**
 * Reads CRLF-terminated header lines starting at `start`, until the blank line
 * that ends the block.
 *
 * Returns `undefined` when the body ends before that blank line, which means the
 * part is incomplete. Measured: an unterminated part is discarded silently (the
 * endpoint then reports the field as missing) rather than failing the request.
 */
function readHeaders(
  body: Buffer,
  start: number,
): { readonly headers: HeaderBlock; readonly contentStart: number } | undefined {
  const headers: HeaderBlock = new Map();
  let index = start;

  for (;;) {
    const lineEnd = body.indexOf(CRLF, index);
    if (lineEnd < 0) {
      return undefined;
    }
    const line = body.toString("latin1", index, lineEnd);
    index = lineEnd + CRLF.length;

    if (line === "") {
      return { headers, contentStart: index };
    }

    const colon = line.indexOf(":");
    if (colon <= 0) {
      // Not a header line. python-multipart would reject the part; keeping the
      // block readable and letting the part fail its own checks is the same
      // observable outcome for every measured input.
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Repeated headers keep the first value, matching `MessageClass.get` on the
    // first occurrence.
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
}

/** Builds the `Content-Disposition` parameters, or the Starlette 400 detail. */
function dispositionParams(
  headers: HeaderBlock,
): { readonly ok: true; readonly params: Map<string, string> } | { readonly ok: false } {
  const disposition = headers.get("content-disposition");
  // A part with no Content-Disposition at all produces the same message as one
  // whose header carries no `name` parameter — measured on both.
  if (disposition === undefined) {
    return { ok: false };
  }
  return { ok: true, params: parseParameters(disposition.split(";").slice(1).join(";")) };
}

/**
 * Parses a `multipart/form-data` body into the `file` field's shape.
 *
 * Reproduces the measured `python-multipart` behaviour:
 *
 * - the body must **start** with `--boundary`; a preamble is refused with
 *   `Invalid multipart data.` (measured — unlike several Node parsers)
 * - line endings must be CRLF; an LF-only body is refused with the same detail
 * - a body whose first delimiter never matches is refused with that detail,
 *   while an unterminated *trailing* part is silently dropped
 * - a part without a `name` parameter → `The Content-Disposition header field
 *   "name" must be provided.`
 * - a non-file part larger than {@link MAX_PART_SIZE} → `Part exceeded maximum
 *   size of 1024KB.`
 * - more than {@link MAX_FILE_PARTS} files or {@link MAX_FIELD_PARTS} fields →
 *   the corresponding "Too many …" detail
 * - the **last** part named `file` wins, whether it is a file or a plain string
 * - an epilogue after the closing `--boundary--` is ignored
 */
function parseMultipartForm(body: Buffer, boundary: string): UploadFormResult {
  // An empty body is an empty form, not a parse failure: measured, it reaches
  // the endpoint and answers `422 missing` for `file`.
  if (body.length === 0) {
    return { kind: "absent" };
  }

  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const terminator = Buffer.concat([CRLF, delimiter]);

  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    return { kind: "invalid", detail: MULTIPART_DETAILS.invalid };
  }

  let position = delimiter.length;
  let fileCount = 0;
  let fieldCount = 0;
  let lastFilePart: PartEntry | undefined;

  for (;;) {
    // `position` sits immediately after a delimiter: next is `--` (close) or
    // CRLF (another part's headers).
    if (body[position] === DASH && body[position + 1] === DASH) {
      break;
    }
    if (
      body[position] !== CRLF[0] ||
      body[position + 1] !== CRLF[1] ||
      body[position] === undefined
    ) {
      return { kind: "invalid", detail: MULTIPART_DETAILS.invalid };
    }
    position += CRLF.length;

    const head = readHeaders(body, position);
    if (head === undefined) {
      // Incomplete part: dropped, exactly like python-multipart.
      break;
    }
    position = head.contentStart;

    const contentEnd = body.indexOf(terminator, position);
    if (contentEnd < 0) {
      // Same: an unterminated part is discarded, and so is everything after it.
      break;
    }
    const content = body.subarray(position, contentEnd);
    position = contentEnd + terminator.length;

    const disposition = dispositionParams(head.headers);
    if (!disposition.ok) {
      return { kind: "invalid", detail: MULTIPART_DETAILS.nameRequired };
    }
    const name = disposition.params.get("name");
    if (name === undefined) {
      return { kind: "invalid", detail: MULTIPART_DETAILS.nameRequired };
    }

    const filename = disposition.params.get("filename");
    if (filename !== undefined) {
      fileCount += 1;
      if (fileCount > MAX_FILE_PARTS) {
        return { kind: "invalid", detail: MULTIPART_DETAILS.tooManyFiles };
      }
      // Only the last `file` part is retained, and every part is counted, so the
      // peak memory is one upload rather than the sum of all of them.
      if (name === FILE_FIELD) {
        lastFilePart = {
          kind: "file",
          file: {
            filename,
            contentType: head.headers.get("content-type") ?? null,
            data: content,
          },
        };
      }
      continue;
    }

    // A non-file part is held in memory by Starlette, which is why it is capped.
    if (content.length > MAX_PART_SIZE) {
      return { kind: "invalid", detail: partTooLargeDetail() };
    }
    fieldCount += 1;
    if (fieldCount > MAX_FIELD_PARTS) {
      return { kind: "invalid", detail: MULTIPART_DETAILS.tooManyFields };
    }
    if (name === FILE_FIELD) {
      lastFilePart = {
        kind: "string",
        value: new TextDecoder("utf-8", { ignoreBOM: true }).decode(content),
      };
    }
  }

  if (lastFilePart === undefined) {
    return { kind: "absent" };
  }
  return lastFilePart.kind === "file"
    ? { kind: "file", file: lastFilePart.file }
    : { kind: "string", value: lastFilePart.value };
}

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
