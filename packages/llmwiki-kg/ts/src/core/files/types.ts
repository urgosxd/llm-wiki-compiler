/**
 * @file packages/llmwiki-kg/ts/src/core/files/types.ts
 * @description The shapes a parsed form takes, plus the byte tokens the parser shares.
 *
 * Split out of `core/files.ts` as its own unit because both the multipart parser
 * and the media-type dispatcher speak this vocabulary, and the route layer
 * imports it as a type-only dependency.
 */

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

/** One parsed part, before the `file` field is picked out. */
export type PartEntry =
  | { readonly kind: "file"; readonly file: UploadedFile }
  | { readonly kind: "string"; readonly value: string };

/** The name this router cares about; every other part is counted and ignored. */
export const FILE_FIELD = "file";

/** CRLF bytes, as a Buffer, for delimiter arithmetic over a `latin1` view. */
export const CRLF = Buffer.from("\r\n", "latin1");

/** `-`, the first byte of a `--boundary` delimiter. */
export const DASH = 0x2d;
