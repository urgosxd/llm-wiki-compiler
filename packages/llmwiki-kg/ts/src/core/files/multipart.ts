/**
 * @file packages/llmwiki-kg/ts/src/core/files/multipart.ts
 * @description The hand-written `multipart/form-data` reader.
 *
 * Split out of `core/files.ts` as its own unit because reproducing
 * `python-multipart` byte-for-byte is the largest and most delicate concern in
 * the upload core, and it is the only place that reasons about delimiters,
 * CRLF framing, and per-part limits.
 */

import {
  MAX_FIELD_PARTS,
  MAX_FILE_PARTS,
  MAX_PART_SIZE,
  MULTIPART_DETAILS,
  partTooLargeDetail,
} from "./constants.js";
import { dispositionParams, readHeaders } from "./headers.js";
import type { HeaderBlock } from "./headers.js";
import { CRLF, DASH, FILE_FIELD } from "./types.js";
import type { PartEntry, UploadFormResult } from "./types.js";

/**
 * What a single part turned out to be: one more iteration, or a 400 detail.
 *
 * Counting stays with the caller so the parser keeps one running tally; this
 * outcome only reports whether the part was a file (for `max_files`) and, when
 * it was named `file`, the entry it contributes.
 */
type PartOutcome =
  | {
      readonly kind: "part";
      readonly isFile: boolean;
      readonly entry: PartEntry | undefined;
    }
  | { readonly kind: "invalid"; readonly detail: string };

/** One read part: the entry it contributes, its kind, and where reading resumes. */
type ReadablePart =
  | {
      readonly kind: "part";
      readonly isFile: boolean;
      readonly entry: PartEntry | undefined;
      readonly next: number;
    }
  | { readonly kind: "stop" }
  | { readonly kind: "invalid"; readonly detail: string };

/** Builds the retained entry for a part that carried a `filename`. */
function fileEntry(
  headers: HeaderBlock,
  filename: string,
  content: Buffer,
): PartEntry {
  return {
    kind: "file",
    file: {
      filename,
      contentType: headers.get("content-type") ?? null,
      data: content,
    },
  };
}

/**
 * Classifies one part, applying the only limit that is per-part.
 *
 * A non-file part is held in memory by Starlette, which is why it is capped;
 * file parts are not size-checked here at all (a 50 MB file part is accepted).
 */
function parsePart(headers: HeaderBlock, content: Buffer): PartOutcome {
  const disposition = dispositionParams(headers);
  if (!disposition.ok) {
    return { kind: "invalid", detail: MULTIPART_DETAILS.nameRequired };
  }
  const name = disposition.params.get("name");
  if (name === undefined) {
    return { kind: "invalid", detail: MULTIPART_DETAILS.nameRequired };
  }

  const filename = disposition.params.get("filename");
  if (filename !== undefined) {
    // Only the last `file` part is retained, and every part is counted, so the
    // peak memory is one upload rather than the sum of all of them.
    return {
      kind: "part",
      isFile: true,
      entry: name === FILE_FIELD ? fileEntry(headers, filename, content) : undefined,
    };
  }

  // A non-file part larger than MAX_PART_SIZE is refused before it is counted.
  if (content.length > MAX_PART_SIZE) {
    return { kind: "invalid", detail: partTooLargeDetail() };
  }
  return {
    kind: "part",
    isFile: false,
    entry:
      name === FILE_FIELD
        ? {
            kind: "string",
            value: new TextDecoder("utf-8", { ignoreBOM: true }).decode(content),
          }
        : undefined,
  };
}

/** Whether `position` sits on the closing `--` of the final delimiter. */
function isClosingDelimiter(body: Buffer, position: number): boolean {
  return body[position] === DASH && body[position + 1] === DASH;
}

/** Whether the CRLF that must follow a delimiter is present and complete. */
function hasCrlfSeparator(body: Buffer, position: number): boolean {
  return (
    body[position] !== undefined &&
    body[position] === CRLF[0] &&
    body[position + 1] === CRLF[1]
  );
}

/** Converts the running tally of retained parts into the form's shape. */
function toFormResult(lastFilePart: PartEntry | undefined): UploadFormResult {
  if (lastFilePart === undefined) {
    return { kind: "absent" };
  }
  return lastFilePart.kind === "file"
    ? { kind: "file", file: lastFilePart.file }
    : { kind: "string", value: lastFilePart.value };
}

/**
 * Reads the part that starts at `position`, or reports why reading stops.
 *
 * `stop` means the part is incomplete and python-multipart would silently drop
 * it — together with everything after it. The caller owns the counters.
 */
function readPart(
  body: Buffer,
  terminator: Buffer,
  position: number,
): ReadablePart {
  const head = readHeaders(body, position);
  if (head === undefined) {
    // Incomplete part: dropped, exactly like python-multipart.
    return { kind: "stop" };
  }
  const contentEnd = body.indexOf(terminator, head.contentStart);
  if (contentEnd < 0) {
    // Same: an unterminated part is discarded, and so is everything after it.
    return { kind: "stop" };
  }
  const content = body.subarray(head.contentStart, contentEnd);
  const outcome = parsePart(head.headers, content);
  if (outcome.kind === "invalid") {
    return outcome;
  }
  return {
    kind: "part",
    isFile: outcome.isFile,
    entry: outcome.entry,
    next: contentEnd + terminator.length,
  };
}

/** Counts one part, or reports the "Too many …" detail that ends parsing. */
function countPart(
  isFile: boolean,
  counts: { fileCount: number; fieldCount: number },
): { readonly detail?: string } {
  if (isFile) {
    counts.fileCount += 1;
    if (counts.fileCount > MAX_FILE_PARTS) {
      return { detail: MULTIPART_DETAILS.tooManyFiles };
    }
    return {};
  }
  counts.fieldCount += 1;
  if (counts.fieldCount > MAX_FIELD_PARTS) {
    return { detail: MULTIPART_DETAILS.tooManyFields };
  }
  return {};
}

/**
 * Walks every part in the body, keeping only the last part named `file`.
 *
 * The walk ends either at the closing delimiter, at an incomplete part (which
 * python-multipart drops silently, along with everything after it), or at the
 * first limit it crosses — in which case the run is a 400.
 */
function readParts(
  body: Buffer,
  frame: { readonly delimiter: Buffer; readonly terminator: Buffer },
): { readonly detail: string } | { readonly lastFilePart: PartEntry | undefined } {
  let position = frame.delimiter.length;
  const counts = { fileCount: 0, fieldCount: 0 };
  let lastFilePart: PartEntry | undefined;

  for (;;) {
    // `position` sits immediately after a delimiter: next is `--` (close) or
    // CRLF (another part's headers).
    if (isClosingDelimiter(body, position)) {
      break;
    }
    if (!hasCrlfSeparator(body, position)) {
      return { detail: MULTIPART_DETAILS.invalid };
    }
    position += CRLF.length;

    const read = readPart(body, frame.terminator, position);
    if (read.kind === "stop") {
      break;
    }
    if (read.kind === "invalid") {
      return { detail: read.detail };
    }
    position = read.next;

    const overLimit = countPart(read.isFile, counts);
    if (overLimit.detail !== undefined) {
      return { detail: overLimit.detail };
    }
    if (read.entry !== undefined) {
      lastFilePart = read.entry;
    }
  }

  return { lastFilePart };
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
export function parseMultipartForm(body: Buffer, boundary: string): UploadFormResult {
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

  const read = readParts(body, { delimiter, terminator });
  return "detail" in read
    ? { kind: "invalid", detail: read.detail }
    : toFormResult(read.lastFilePart);
}
