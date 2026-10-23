/**
 * @file packages/llmwiki-kg/ts/src/core/files-multipart.test.ts
 * @description The `multipart/form-data` parser and media-type dispatch.
 */

import { describe, expect, it } from "vitest";
import { MAX_PART_SIZE, parseUploadForm } from "./files.js";
import { BOUNDARY, bytes, multipart, multipartContentType } from "./files-harness.js";

describe("parseUploadForm", () => {
  it("extracts the file part with its bytes, filename and content type", () => {
    const body = multipart([
      {
        name: "file",
        filename: "probe1.txt",
        contentType: "text/plain",
        data: "hello documents world\n",
      },
    ]);

    const result = parseUploadForm(body, multipartContentType());

    expect(result.kind).toBe("file");
    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.filename).toBe("probe1.txt");
    expect(result.file.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(result.file.data)).toBe(
      "hello documents world\n",
    );
  });

  it("reports a file part with no Content-Type as null content type", () => {
    // Measured: a part sent without a Content-Type header stores
    // `content_type: null`.
    const body = multipart([{ name: "file", filename: "noct.txt", data: "x" }]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.contentType).toBeNull();
  });

  it("keeps a parameterized content type verbatim", () => {
    // Measured: `Content-Type: text/plain; charset=utf-8` is stored unchanged.
    const body = multipart([
      {
        name: "file",
        filename: "cs.txt",
        contentType: "text/plain; charset=utf-8",
        data: "x",
      },
    ]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.contentType).toBe("text/plain; charset=utf-8");
  });

  it("reports an absent file when the form has no `file` part", () => {
    const body = multipart([{ name: "other", data: "x" }]);
    expect(parseUploadForm(body, multipartContentType()).kind).toBe("absent");
  });

  it("reports an absent file for a body that is not a form at all", () => {
    // Measured: `text/plain` and `application/json` bodies reach the endpoint
    // with an empty form and answer `422 missing` for `file`.
    expect(parseUploadForm(bytes("raw"), "text/plain").kind).toBe("absent");
    expect(parseUploadForm(bytes("{}"), "application/json").kind).toBe("absent");
    expect(parseUploadForm(bytes(""), undefined).kind).toBe("absent");
  });

  it("treats a `file` part with no filename as a plain string field", () => {
    // Measured: FastAPI then reports `Expected UploadFile, received:
    // <class 'str'>` with the field text as `input`.
    const body = multipart([{ name: "file", data: "no filename param bytes\n" }]);
    const result = parseUploadForm(body, multipartContentType());

    expect(result).toEqual({
      kind: "string",
      value: "no filename param bytes\n",
    });
  });

  it("keeps the last part when several carry the name `file`", () => {
    // Measured: two file parts resolve to the second one (`two_b.txt`), and a
    // trailing string field named `file` wins over an earlier file.
    const twoFiles = multipart([
      { name: "file", filename: "two_a.txt", data: "first" },
      { name: "file", filename: "two_b.txt", data: "second" },
    ]);
    const fileResult = parseUploadForm(twoFiles, multipartContentType());
    if (fileResult.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(fileResult.file.filename).toBe("two_b.txt");

    const mixed = multipart([
      { name: "file", filename: "f1.txt", data: "first" },
      { name: "file", data: "plain string" },
    ]);
    expect(parseUploadForm(mixed, multipartContentType())).toEqual({
      kind: "string",
      value: "plain string",
    });
  });

  it("returns the file part unchanged when it is empty", () => {
    // An empty file is a real UploadFile: the handler answers
    // `400 Uploaded file is empty`, not a validation error.
    const body = multipart([{ name: "file", filename: "empty.txt", data: "" }]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.data.length).toBe(0);
  });

  it("accepts an empty filename and leaves the fallback to the caller", () => {
    // Measured: `filename=""` stores the row with `filename: "unknown"`, which
    // is the handler's `file.filename or "unknown"`.
    const body = multipart([{ name: "file", filename: "", data: "fe bytes" }]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.filename).toBe("");
    expect(result.file.data.length).toBe(8);
  });

  it("reads an unquoted Content-Disposition name", () => {
    const body = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name=file; filename=uq.txt\r\n\r\nuq bytes\r\n--${BOUNDARY}--\r\n`,
      ),
    ]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.filename).toBe("uq.txt");
  });

  it("accepts a quoted boundary", () => {
    const body = multipart(
      [{ name: "file", filename: "qb.txt", data: "payload" }],
      "a b",
    );
    const result = parseUploadForm(body, 'multipart/form-data; boundary="a b"');

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.filename).toBe("qb.txt");
  });

  it("rejects a multipart content type with no boundary", () => {
    expect(parseUploadForm(bytes("xx"), "multipart/form-data")).toEqual({
      kind: "invalid",
      detail: "Missing boundary in multipart.",
    });
  });

  it("rejects structurally invalid multipart data", () => {
    // All three were measured as `{"detail": "Invalid multipart data."}`:
    // garbage before the first delimiter, LF-only line endings, and a body
    // whose delimiters do not match the declared boundary.
    const cases: Uint8Array[] = [
      bytes("garbage"),
      bytes(
        `--${BOUNDARY}\nContent-Disposition: form-data; name="file"; filename="lf.txt"\n\nlf bytes\n--${BOUNDARY}--\n`,
      ),
      bytes(
        '--CCC\r\nContent-Disposition: form-data; name="file"; filename="wb.txt"\r\n\r\npayload\r\n--CCC--\r\n',
      ),
      bytes("preamble junk\r\n--" + BOUNDARY + "--\r\n"),
    ];

    for (const body of cases) {
      expect(parseUploadForm(body, multipartContentType())).toEqual({
        kind: "invalid",
        detail: "Invalid multipart data.",
      });
    }
  });

  it("requires the Content-Disposition name parameter", () => {
    // Measured exact strings from python-multipart, surfaced by Starlette as a
    // 400 with this detail.
    const detail = 'The Content-Disposition header field "name" must be provided.';

    const noName = multipart([{ filename: "a.txt", data: "payload" }]);
    expect(parseUploadForm(noName, multipartContentType())).toEqual({
      kind: "invalid",
      detail,
    });

    const noDisposition = multipart([
      { omitDisposition: true, data: "payload" },
    ]);
    expect(parseUploadForm(noDisposition, multipartContentType())).toEqual({
      kind: "invalid",
      detail,
    });
  });

  it("drops a part whose terminating boundary never arrives", () => {
    // Measured: an unterminated part is discarded silently, so the endpoint
    // sees no `file` field and answers `422 missing`.
    const unterminated = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="nc.txt"\r\n\r\npayload\r\n`,
    );
    expect(parseUploadForm(unterminated, multipartContentType()).kind).toBe(
      "absent",
    );

    const headersNoBlankLine = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="hb.txt"\r\n`,
    );
    expect(
      parseUploadForm(headersNoBlankLine, multipartContentType()).kind,
    ).toBe("absent");
  });

  it("finds the boundary inside content that merely contains the token", () => {
    // Measured: content `AA--BBBB\r\n` is stored with `size_bytes: 10`.
    const body = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="bi.txt"\r\n\r\nAA--BBBB\r\n\r\n--${BOUNDARY}--\r\n`,
      ),
    ]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.data.length).toBe(10);
    expect(new TextDecoder().decode(result.file.data)).toBe("AA--BBBB\r\n");
  });

  it("ignores an epilogue after the closing delimiter", () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="junk.txt"\r\n\r\njd\r\n--${BOUNDARY}--\r\nJUNKJUNK`,
    );
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(new TextDecoder().decode(result.file.data)).toBe("jd");
  });

  it("rejects a non-file part larger than 1MB", () => {
    // Measured: a 1 MiB field passes, one byte more answers
    // `400 Part exceeded maximum size of 1024KB.`
    const atLimit = multipart([
      { name: "note", data: "z".repeat(MAX_PART_SIZE) },
      { name: "file", filename: "f1m.txt", data: "x" },
    ]);
    expect(parseUploadForm(atLimit, multipartContentType()).kind).toBe("file");

    const overLimit = multipart([
      { name: "note", data: "z".repeat(MAX_PART_SIZE + 1) },
    ]);
    expect(parseUploadForm(overLimit, multipartContentType())).toEqual({
      kind: "invalid",
      detail: "Part exceeded maximum size of 1024KB.",
    });
  });

  it("does not apply the part limit to file parts", () => {
    // Measured: a 50 MB upload succeeds, so `max_part_size` only guards the
    // non-file (in-memory) parts.
    const body = multipart([
      {
        name: "file",
        filename: "big.bin",
        data: new Uint8Array(MAX_PART_SIZE * 2 + 7),
      },
    ]);
    const result = parseUploadForm(body, multipartContentType());

    if (result.kind !== "file") {
      throw new Error("expected a file part");
    }
    expect(result.file.data.length).toBe(MAX_PART_SIZE * 2 + 7);
  });

  it("rejects more than 1000 file parts", () => {
    // Measured: 1000 files pass, 1001 answer
    // `400 Too many files. Maximum number of files is 1000.`
    const files = (count: number): Uint8Array =>
      multipart(
        Array.from({ length: count }, (_unused, index) => ({
          name: "file",
          filename: `f${String(index)}.txt`,
          data: "v",
        })),
      );

    expect(parseUploadForm(files(1000), multipartContentType()).kind).toBe("file");
    expect(parseUploadForm(files(1001), multipartContentType())).toEqual({
      kind: "invalid",
      detail: "Too many files. Maximum number of files is 1000.",
    });
  });

  it("rejects more than 1000 non-file fields", () => {
    const fields = (count: number): Uint8Array =>
      multipart(
        Array.from({ length: count }, (_unused, index) => ({
          name: `f${String(index)}`,
          data: "v",
        })),
      );

    expect(parseUploadForm(fields(1000), multipartContentType()).kind).toBe(
      "absent",
    );
    expect(parseUploadForm(fields(1001), multipartContentType())).toEqual({
      kind: "invalid",
      detail: "Too many fields. Maximum number of fields is 1000.",
    });
  });

  it("parses urlencoded bodies, where `file` can only be a string", () => {
    expect(parseUploadForm(bytes("file=abc"), "application/x-www-form-urlencoded")).toEqual({
      kind: "string",
      value: "abc",
    });
    expect(parseUploadForm(bytes("note=x"), "application/x-www-form-urlencoded").kind).toBe(
      "absent",
    );
  });

  it("does not treat a differently-cased multipart media type as multipart", () => {
    // Measured: `MULTIPART/FORM-DATA; boundary=BBB` and
    // `Multipart/Form-Data; boundary=BBB` both answer `422 missing`.
    const body = multipart([{ name: "file", filename: "uc.txt", data: "x" }]);
    expect(parseUploadForm(body, `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`).kind).toBe(
      "absent",
    );
    expect(parseUploadForm(body, `Multipart/Form-Data; boundary=${BOUNDARY}`).kind).toBe(
      "absent",
    );
  });
});
