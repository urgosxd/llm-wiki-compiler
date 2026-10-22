/**
 * @file packages/llmwiki-kg/ts/src/core/files-truncation.test.ts
 * @description Truncation detection and UTF-8 probing.
 */

import { describe, expect, it } from "vitest";
import { MAX_EXTRACTION_CHARS, checkTruncation, tryDecodeAsText } from "./files.js";
import { bytes } from "./files-harness.js";

describe("checkTruncation", () => {
  it("does not truncate text at or below MAX_EXTRACTION_CHARS", () => {
    expect(checkTruncation("")).toEqual({ truncated: false, originalLength: null });
    expect(checkTruncation("x".repeat(MAX_EXTRACTION_CHARS))).toEqual({
      truncated: false,
      originalLength: null,
    });
  });

  it("truncates one character past the limit and reports the length", () => {
    // Measured: a 500001-byte text file answers `truncated: true,
    // original_length: 500001`.
    expect(checkTruncation("x".repeat(MAX_EXTRACTION_CHARS + 1))).toEqual({
      truncated: true,
      originalLength: MAX_EXTRACTION_CHARS + 1,
    });
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    // Python's `len()` counts code points. Measured: a file of 500001 emoji
    // (2,000,004 bytes) answers `original_length: 500001`, while 300000 emoji
    // are below the limit even though they are 600000 UTF-16 units.
    const emoji = "\u{1F600}";
    expect(checkTruncation(emoji.repeat(300_000))).toEqual({
      truncated: false,
      originalLength: null,
    });
    expect(checkTruncation(emoji.repeat(MAX_EXTRACTION_CHARS + 1))).toEqual({
      truncated: true,
      originalLength: MAX_EXTRACTION_CHARS + 1,
    });
  });
});

describe("tryDecodeAsText", () => {
  it("decodes valid UTF-8", () => {
    expect(tryDecodeAsText(bytes("plain text\n"))).toBe("plain text\n");
    expect(tryDecodeAsText(bytes(""))).toBe("");
    expect(tryDecodeAsText(bytes("emoji \u{1F600}\n"))).toBe("emoji \u{1F600}\n");
  });

  it("returns null for bytes that are not valid UTF-8", () => {
    // Python's `data.decode("utf-8")` raises `UnicodeDecodeError` here, so the
    // oracle stores `truncated: false, original_length: null` for this content.
    expect(tryDecodeAsText(Uint8Array.from([0xff, 0xfe, 0x00, 0x01]))).toBeNull();
    // A lone continuation byte is equally invalid.
    expect(tryDecodeAsText(Uint8Array.from([0x80]))).toBeNull();
  });
});
