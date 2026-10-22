/**
 * @file packages/llmwiki-kg/ts/src/core/files/truncation.ts
 * @description Truncation detection and UTF-8 text probing for an upload.
 *
 * Split out of `core/files.ts` as its own unit because the code-point counting
 * here exists only to match Python `len()`/`bytes.decode("utf-8")` semantics and
 * is unrelated to the multipart parser in the same original file.
 */

import { MAX_EXTRACTION_CHARS } from "./constants.js";

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
