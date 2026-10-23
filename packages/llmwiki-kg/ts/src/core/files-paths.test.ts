/**
 * @file packages/llmwiki-kg/ts/src/core/files-paths.test.ts
 * @description Constants, content hashing and storage-path derivation.
 */

import { describe, expect, it } from "vitest";
import { MAX_EXTRACTION_CHARS, MAX_PART_SIZE, MAX_UPLOAD_BYTES, UPLOAD_DIR, computeSha256, getStoragePath } from "./files.js";
import { DOCUMENT_ID, STACK_ID, bytes } from "./files-harness.js";

describe("constants", () => {
  it("matches app/core/constants.py", () => {
    // 50 * 1024 * 1024 — the oracle answers `File exceeds 52428800 byte limit`.
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBe(52_428_800);
    expect(MAX_EXTRACTION_CHARS).toBe(500_000);
    // `UPLOAD_DIR = "uploads"`, relative to the server's working directory.
    expect(UPLOAD_DIR).toBe("uploads");
    // Starlette's `Request.form()` default (1024 * 1024), reproduced because the
    // oracle rejects an oversized non-file part with
    // `Part exceeded maximum size of 1024KB.`
    expect(MAX_PART_SIZE).toBe(1024 * 1024);
  });
});

describe("computeSha256", () => {
  it("returns the lowercase hex SHA-256 of the bytes", () => {
    // NIST vector for "abc".
    expect(computeSha256(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(computeSha256(bytes(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes the exact uploaded bytes, not a re-encoding of them", () => {
    // Measured on the oracle for a file containing "hello documents world\n".
    const content = bytes("hello documents world\n");
    expect(computeSha256(content)).toBe(
      "7045ce681c23cdfe1be71e0483b3e2e8bdd762b353d87bbd46433d3870ed9712",
    );
    // Byte-oriented: a code-point view of the same text would hash differently.
    expect(computeSha256(content)).not.toBe(
      computeSha256(bytes("hello documents world")),
    );
  });
});

describe("getStoragePath", () => {
  it("builds uploads/{stack_id}/{document_id}{ext}", () => {
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, "notes.txt")).toBe(
      `uploads/${STACK_ID}/${DOCUMENT_ID}.txt`,
    );
    // Measured shape in `stack_documents.storage_path`.
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, "probe1.txt")).toBe(
      "uploads/20efd96a-f6e1-4994-8812-65113f8db4db/d1dfd574-43db-49bc-9ef4-a43f7ad89e2f.txt",
    );
  });

  it("keeps only the last suffix, as pathlib does", () => {
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, "a.b.tar.gz")).toBe(
      `uploads/${STACK_ID}/${DOCUMENT_ID}.gz`,
    );
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, "weird name.TXT")).toBe(
      `uploads/${STACK_ID}/${DOCUMENT_ID}.TXT`,
    );
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, ".a.b")).toBe(
      `uploads/${STACK_ID}/${DOCUMENT_ID}.b`,
    );
  });

  it("omits the extension where PurePosixPath().suffix is empty", () => {
    // Every row below was checked against Python's `PurePosixPath(...).suffix`;
    // the oracle stores `../../etc/passwdx` with no extension appended.
    for (const filename of [
      "noext",
      ".hidden",
      "foo.",
      ".a",
      "../../etc/passwdx",
      "dir.name/file",
      "",
    ]) {
      expect(getStoragePath(STACK_ID, DOCUMENT_ID, filename)).toBe(
        `uploads/${STACK_ID}/${DOCUMENT_ID}`,
      );
    }
  });

  it("resolves the suffix from the final path component only", () => {
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, "x.y/z.w")).toBe(
      `uploads/${STACK_ID}/${DOCUMENT_ID}.w`,
    );
    expect(getStoragePath(STACK_ID, DOCUMENT_ID, "dir/file.txt")).toBe(
      `uploads/${STACK_ID}/${DOCUMENT_ID}.txt`,
    );
  });
});
