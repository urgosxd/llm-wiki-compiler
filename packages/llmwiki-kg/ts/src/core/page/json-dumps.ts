/**
 * @file packages/llmwiki-kg/ts/src/core/page/json-dumps.ts
 * @description Re-emitting a jsonb text form the way `json.dumps(sort_keys=True)` would.
 *
 * Split out of `core/page_generator.ts` as its own unit because `1` vs `1.0`,
 * code-point key ordering and `ensure_ascii` escaping are one self-contained
 * problem: the graph-version hash is taken over this text, so the number source
 * has to survive `JSON.parse`.
 */

import { PythonFormatError, pythonFloatRepr } from "./float-repr.js";

/**
 * A JSON number that remembers how it was written.
 *
 * `1` and `1.0` are different Python values (`int` and `float`) whose
 * `json.dumps` output differs, but both become the number `1` in JavaScript.
 * The jsonb text form distinguishes them, so the reviver below keeps the source
 * text instead of the value.
 */
export class JsonNumberSource {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

/** The short escapes `json.dumps` keeps instead of `\\uXXXX`. */
const SHORT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\t", "\\t"],
  ["\r", "\\r"],
  ["\b", "\\b"],
  ["\f", "\\f"],
]);

/** Above `~`, `ensure_ascii=True` escapes, so no byte stays unescaped. */
const PRINTABLE_ASCII_LIMIT = 0x7e;

/** One character of a JSON string, escaped as `ensure_ascii=True` escapes it. */
function escapedChar(char: string, code: number): string {
  const short = SHORT_ESCAPES.get(char);
  if (short !== undefined) {
    return short;
  }
  if (code < 0x20 || code > PRINTABLE_ASCII_LIMIT) {
    return `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return char;
}

/**
 * Escapes a string the way `json.dumps` does with `ensure_ascii=True`.
 *
 * Measured: `é` -> `\u00e9`, `🙂` -> `\ud83d\ude42` (a surrogate pair, lowercase
 * hex), while `\n`, `\t`, `\r`, `\b` and `\f` keep their short escapes.
 */
export function pythonJsonString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === undefined) {
      continue;
    }
    out += escapedChar(char, value.charCodeAt(index));
  }
  return `${out}"`;
}

/** True when Python would treat the parsed JSON value as falsy. */
export function isPythonFalsy(value: unknown): boolean {
  if (value === null || value === false) {
    return true;
  }
  if (typeof value === "number") {
    return value === 0;
  }
  if (typeof value === "string") {
    return value === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (value instanceof JsonNumberSource) {
    return Number(value.source) === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Python string ordering, which compares code points.
 *
 * `Array.prototype.sort` compares UTF-16 code units, so it orders an astral
 * character (a surrogate pair) *before* a BMP character above `U+FFFF`'s range
 * such as `U+FFFD`, while Python orders by code point. Entity names can contain
 * either, and the relationship list is sorted, so the difference would change
 * the hash.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  for (;;) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();
    if (leftStep.done === true || rightStep.done === true) {
      if (leftStep.done === true && rightStep.done === true) {
        return 0;
      }
      return leftStep.done === true ? -1 : 1;
    }
    const leftCode = leftStep.value.codePointAt(0) ?? 0;
    const rightCode = rightStep.value.codePointAt(0) ?? 0;
    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1;
    }
  }
}

/** Emits a parsed jsonb value the way `json.dumps(sort_keys=True)` would. */
export function emitPythonJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "string") {
    return pythonJsonString(value);
  }
  if (value instanceof JsonNumberSource) {
    // An integer keeps its digits verbatim (Python's `int` has no precision
    // limit, and a >2^53 jsonb integer would otherwise be rounded).
    if (!/[.eE]/.test(value.source)) {
      return value.source;
    }
    return pythonFloatRepr(Number(value.source));
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => emitPythonJson(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const record: Record<string, unknown> = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    const members = keys.map(
      (key) => `${pythonJsonString(key)}: ${emitPythonJson(record[key])}`,
    );
    return `{${members.join(", ")}}`;
  }
  throw new PythonFormatError(
    `Unsupported JSON value in properties: ${typeof value}`,
  );
}

/** Reviver that replaces every JSON number with its source text. */
export function numberSourceReviver(
  _key: string,
  value: unknown,
  context?: { readonly source?: string },
): unknown {
  if (typeof value !== "number") {
    return value;
  }
  const source = context?.source;
  if (source === undefined) {
    // Node < 24 does not pass the source context. Failing loudly beats silently
    // hashing `1` where Python hashed `1.0`.
    throw new PythonFormatError(
      "JSON.parse did not supply number source text; Node >= 24 is required",
    );
  }
  return new JsonNumberSource(source);
}

/**
 * `json.dumps(properties or {}, sort_keys=True)`, from the jsonb text form.
 *
 * The `or {}` is Python's truthiness rule, so a jsonb `null`, `{}`, `[]`, `""`,
 * `0`, `0.0` or `false` all become `{}` — the same substitution
 * `entity_row.get("properties") or {}` makes.
 *
 * A **truthy** non-object is emitted as itself rather than rejected: measured on
 * the oracle, `properties` of jsonb `5` hashes `5` and `"x"` hashes `"x"`. The
 * column is `jsonb` with an object-shaped default, so a scalar means hand-written
 * data — and the outcome that matters is that both servers agree, not that the
 * input was sane.
 */
export function pythonJsonDumps(jsonbText: string | null): string {
  if (jsonbText === null) {
    return "{}";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonbText, numberSourceReviver);
  } catch (error) {
    if (error instanceof PythonFormatError) {
      throw error;
    }
    throw new PythonFormatError(
      `properties is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return isPythonFalsy(parsed) ? "{}" : emitPythonJson(parsed);
}
