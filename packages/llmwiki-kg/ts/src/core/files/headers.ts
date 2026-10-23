/**
 * @file packages/llmwiki-kg/ts/src/core/files/headers.ts
 * @description Header-value and header-block parsing for the multipart reader.
 *
 * Split out of `core/files.ts` as its own unit because `parse_options_header`
 * semantics (quoted values, backslash escapes, bare tokens) and the CRLF header
 * block scan are a self-contained concern the `file`-field selection never
 * needs to see.
 */

import { CRLF } from "./types.js";

/** A header value split into its leading value and its parameters. */
export interface ParsedHeaderValue {
  readonly value: string;
  /** Parameter names lowercased, values unquoted. */
  readonly params: ReadonlyMap<string, string>;
}

/** A parsed header block: header names lowercased, values trimmed. */
export type HeaderBlock = Map<string, string>;

/** Skips the separators that may precede a parameter name. */
function skipParameterSeparators(source: string, start: number): number {
  let index = start;
  while (index < source.length && (source[index] === ";" || source[index] === " ")) {
    index += 1;
  }
  return index;
}

/** Advances past a bare token that carries no `=`. */
function skipBareToken(source: string, start: number): number {
  let index = start;
  while (index < source.length && source[index] !== ";") {
    index += 1;
  }
  return index;
}

/**
 * Reads a quoted parameter value, honouring backslash escapes.
 *
 * @returns the unquoted text and the index just past the closing quote.
 */
function readQuotedValue(
  source: string,
  start: number,
): { readonly value: string; readonly next: number } {
  let index = start + 1;
  let collected = "";
  while (index < source.length && source[index] !== '"') {
    if (source[index] === "\\" && index + 1 < source.length) {
      index += 1;
    }
    collected += source[index] ?? "";
    index += 1;
  }
  // Skip the closing quote.
  return { value: collected, next: index + 1 };
}

/** Reads an unquoted parameter value up to the next `;`. */
function readBareValue(
  source: string,
  start: number,
): { readonly value: string; readonly next: number } {
  let index = start;
  while (index < source.length && source[index] !== ";") {
    index += 1;
  }
  return { value: source.slice(start, index).trim(), next: index };
}

/**
 * Splits `key=value; key="quoted value"` into a map.
 *
 * Handles quoted values (with backslash escapes) and unquoted values, which is
 * what `parse_options_header` accepts. Semicolons inside quotes are not
 * separators: measured, `Content-Type: text/plain; charset=utf-8` arrives intact.
 */
export function parseParameters(source: string): Map<string, string> {
  const params = new Map<string, string>();
  let index = 0;

  while (index < source.length) {
    index = skipParameterSeparators(source, index);
    const keyStart = index;
    while (index < source.length && source[index] !== "=" && source[index] !== ";") {
      index += 1;
    }
    if (index >= source.length || source[index] !== "=") {
      // A bare token with no `=`; run past it.
      index = skipBareToken(source, index);
      continue;
    }
    const key = source.slice(keyStart, index).trim().toLowerCase();
    index += 1;

    const read =
      source[index] === '"'
        ? readQuotedValue(source, index)
        : readBareValue(source, index);
    index = read.next;

    if (key !== "") {
      params.set(key, read.value);
    }
  }

  return params;
}

/** Splits one header (or `Content-Type`) value into its value and parameters. */
export function parseHeaderValue(raw: string): ParsedHeaderValue {
  const separator = raw.indexOf(";");
  if (separator < 0) {
    return { value: raw.trim(), params: new Map() };
  }
  return {
    value: raw.slice(0, separator).trim(),
    params: parseParameters(raw.slice(separator + 1)),
  };
}

/**
 * Reads CRLF-terminated header lines starting at `start`, until the blank line
 * that ends the block.
 *
 * Returns `undefined` when the body ends before that blank line, which means the
 * part is incomplete. Measured: an unterminated part is discarded silently (the
 * endpoint then reports the field as missing) rather than failing the request.
 */
export function readHeaders(
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
export function dispositionParams(
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
