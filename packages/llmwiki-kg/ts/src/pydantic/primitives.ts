/**
 * @file packages/llmwiki-kg/ts/src/pydantic/primitives.ts
 * @description Zod schemas that accept and reject exactly what Pydantic's lax
 * mode does, tagging every issue with the Pydantic error it corresponds to.
 *
 * They are not plain `z.string()` / `z.number()` because the two libraries
 * disagree in ways a mapper cannot repair after the fact: Zod reports
 * `expected: "number"` for both `z.number()` and `z.int()`, discards the raw
 * input on coercion failure, and runs every string check instead of stopping at
 * the first. Each primitive validates by hand and raises one custom issue
 * carrying Pydantic's `{type, msg, ctx}` in `issue.params`, which the mapper
 * reads first.
 */

import { z } from "zod";

import {
  BOOL_PARSING,
  BOOL_TYPE,
  DICT_TYPE,
  FLOAT_PARSING,
  FLOAT_TYPE,
  INT_FROM_FLOAT,
  INT_PARSING,
  INT_TYPE,
  MISSING,
  STRING_TYPE,
  boundError,
  isRecord,
  scalar,
  stringPatternMismatch,
  stringTooLong,
  stringTooShort,
} from "./pydantic-meta.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  /**
   * Pydantic's `Field(pattern=...)`. Python's `re.search` semantics, so the
   * pattern need not match the whole string. `source` is the raw pattern text
   * quoted back in `msg` and `ctx`.
   */
  readonly pattern?: { readonly regex: RegExp; readonly source: string };
}

/**
 * `str`. Pydantic's lax mode does not coerce numbers or booleans into strings
 * (verified on the oracle: `{"name": 123}` is `string_type`), so any non-string
 * is a type error.
 *
 * Constraints run in Pydantic's order — `min_length`, `max_length`, `pattern` —
 * and the first failure aborts, because Pydantic reports at most one constraint
 * error per field. A native `.min().regex()` chain would report both.
 */
export function pydanticString(options: StringOptions = {}): z.ZodType<string> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }
    if (typeof value !== "string") {
      return failHere(STRING_TYPE);
    }
    // Python's `len()` counts Unicode code points; `String.prototype.length`
    // counts UTF-16 code units. They agree for BMP text and diverge for astral
    // characters, where one code point (an emoji) is two units. The oracle
    // accepts a 101-emoji name because it is 101 code points, so counting
    // `.length` here would reject it at 202 units. `[...value].length` counts
    // code points by iterating the string's code points, matching Python.
    const codePointLength = [...value].length;
    if (options.minLength !== undefined && codePointLength < options.minLength) {
      return failHere(stringTooShort(options.minLength));
    }
    if (options.maxLength !== undefined && codePointLength > options.maxLength) {
      return failHere(stringTooLong(options.maxLength));
    }
    if (options.pattern !== undefined && !options.pattern.regex.test(value)) {
      return failHere(stringPatternMismatch(options.pattern.source));
    }
    return value;
  });
}

export interface NumberOptions {
  readonly ge?: number;
  readonly le?: number;
}

/**
 * `int`. Pydantic's lax JSON mode accepts integers, floats with no fractional
 * part (`5.0`), strings whose trimmed form is `[+-]?digits`, and booleans
 * (`true` -> 1); all four were confirmed on the oracle. Each rejection path
 * reports the specific code that explains *why*, which is the only way
 * `int_parsing` and `int_from_float` can be told apart from `int_type`.
 */
export function pydanticInt(options: NumberOptions = {}): z.ZodType<number> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }

    let parsed: number;
    if (typeof value === "boolean") {
      parsed = value ? 1 : 0;
    } else if (typeof value === "number") {
      if (!Number.isInteger(value)) {
        return failHere(INT_FROM_FLOAT);
      }
      parsed = value;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^[+-]?\d+$/.test(trimmed)) {
        return failHere(INT_PARSING);
      }
      parsed = Number.parseInt(trimmed, 10);
    } else {
      return failHere(INT_TYPE);
    }

    if (options.ge !== undefined && parsed < options.ge) {
      return failHere(boundError(options.ge, "ge"));
    }
    if (options.le !== undefined && parsed > options.le) {
      return failHere(boundError(options.le, "le"));
    }
    return parsed;
  });
}

/**
 * `float`. Accepts numbers, booleans and anything Python's `float()` reads
 * (`"1e3"`, `" 0.5 "`); reports `float_parsing` for an unreadable string and
 * `float_type` for a non-numeric JSON value.
 */
export function pydanticFloat(options: NumberOptions = {}): z.ZodType<number> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }

    let parsed: number;
    if (typeof value === "boolean") {
      parsed = value ? 1 : 0;
    } else if (typeof value === "number") {
      parsed = value;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      parsed = trimmed === "" ? Number.NaN : Number(trimmed);
      if (Number.isNaN(parsed)) {
        return failHere(FLOAT_PARSING);
      }
    } else {
      return failHere(FLOAT_TYPE);
    }

    if (options.ge !== undefined && parsed < options.ge) {
      return failHere(boundError(options.ge, "ge"));
    }
    if (options.le !== undefined && parsed > options.le) {
      return failHere(boundError(options.le, "le"));
    }
    return parsed;
  });
}

/** The textual and numeric forms Pydantic's lax bool parser accepts. */
const TRUE_STRINGS = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_STRINGS = new Set(["0", "off", "f", "false", "n", "no"]);

/**
 * `bool`. Accepts booleans, `0` / `1` (including `0.0` / `1.0`) and the usual
 * textual forms. Any other number or string is `bool_parsing`; a non-scalar is
 * `bool_type`.
 */
export function pydanticBoolean(): z.ZodType<boolean> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return failHere(BOOL_PARSING);
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (TRUE_STRINGS.has(normalized)) {
        return true;
      }
      if (FALSE_STRINGS.has(normalized)) {
        return false;
      }
      return failHere(BOOL_PARSING);
    }
    return failHere(BOOL_TYPE);
  });
}

/**
 * `dict`. Any JSON object. Arrays and `null` are `dict_type`, matching the
 * oracle for `metadata: dict`.
 *
 * Use `.default(() => ({}))` at the call site for Pydantic's `= {}`, so each
 * parse gets a fresh object rather than one shared literal.
 */
export function pydanticDict(): z.ZodType<Record<string, unknown>> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }
    if (!isRecord(value)) {
      return failHere(DICT_TYPE);
    }
    return value;
  });
}
