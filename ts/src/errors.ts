import { z } from "zod";

/**
 * Pydantic/FastAPI compatibility layer for Zod.
 *
 * Two halves live here because they share one contract:
 *
 * 1. **Primitives** — Zod schemas that accept and reject exactly what
 *    Pydantic's lax mode does, tagging every issue they raise with the Pydantic
 *    error it corresponds to ({@link pydanticString}, {@link pydanticInt}, …).
 * 2. **The mapper** — {@link toFastApiValidationError}, which rewrites a
 *    `ZodError` into FastAPI's `422 {"detail": [...]}` body.
 *
 * ## Why the primitives are not plain `z.string()` / `z.number()`
 *
 * Zod and Pydantic disagree in ways a mapper alone cannot repair, because the
 * information is already gone by the time Zod's issue exists:
 *
 * - `z.number()` and `z.int()` both report `expected: "number"` for a string,
 *   but Pydantic distinguishes `int_parsing` from `float_parsing` — different
 *   code *and* different message.
 * - `z.coerce.number()` accepts `"5"` but discards the raw value on failure, so
 *   the error's `input` cannot be reproduced.
 * - `z.uuid()` enforces RFC 9562 version/variant nibbles; Pydantic accepts any
 *   hex UUID (`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` parses on the oracle).
 * - Zod's string pipeline runs every check and reports all of them; Pydantic
 *   reports only the first failing constraint per field.
 *
 * Each primitive below validates by hand and raises exactly one custom issue
 * carrying the Pydantic `{type, msg, ctx}` in `issue.params`. The mapper reads
 * that metadata first and falls back to generic translation only for issues
 * raised by plain Zod schemas (`z.object`, `z.array`, `z.literal`), which
 * already line up with Pydantic's `model_attributes_type` / `list_type` /
 * `literal_error` shapes.
 *
 * ## Nullability lives at the call site, not here
 *
 * Every primitive rejects `null` with the Pydantic *type* error
 * (`string_type`, `int_type`, `bool_type`, `dict_type`, `uuid_type`) and
 * rejects a missing key as `missing`. Adding `.nullable()` at the call site
 * reproduces `Optional[X]`: Zod short-circuits `null` before the transform, so
 * it is accepted, while a missing key still fails. `Optional[X]` with no
 * default is therefore `.nullable()` alone, and `Optional[X] = None` is
 * `.nullable().default(null)`. That distinction is load-bearing and must not be
 * collapsed.
 *
 * ## Timestamps
 *
 * There is no `datetime` primitive on purpose: those fields are validated as
 * strings. `Date` holds milliseconds while Postgres and Pydantic carry
 * microseconds, so parsing into `Date` would silently destroy precision. See
 * `db.ts` and `odd/findings/timestamp-precision.md`.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Where a value came from; FastAPI prefixes every `loc` array with it. */
export type LocPrefix = "body" | "path" | "query";

/** One entry of FastAPI's `422 {"detail": [...]}` array. */
export interface PydanticErrorDetail {
  readonly type: string;
  readonly loc: (string | number)[];
  readonly msg: string;
  /**
   * The offending value exactly as received. For `missing` this is the *parent*
   * object (or `null` for path/query) — see {@link missingInput}.
   */
  readonly input: unknown;
  readonly ctx?: Record<string, unknown>;
}

/** FastAPI's validation-failure envelope. */
export interface ValidationFailure {
  readonly status: 422;
  readonly body: { readonly detail: PydanticErrorDetail[] };
}

/** FastAPI's ordinary error envelope: one `detail` string, not an array. */
export interface ApiError {
  readonly status: number;
  readonly body: { readonly detail: string };
}

/**
 * Non-validation error helper. FastAPI renders `HTTPException` as
 * `{"detail": "<message>"}`, which is structurally different from the 422 array
 * above; 400/404/409 all use this shape.
 */
export function apiError(status: number, detail: string): ApiError {
  return { status, body: { detail } };
}

// ---------------------------------------------------------------------------
// Issue metadata protocol
// ---------------------------------------------------------------------------

/**
 * The Pydantic error a primitive wants reported. `type` is Pydantic's error
 * code, `msg` its message and `ctx` its optional context. All three are copied
 * into the 422 body verbatim, so they are spelled exactly as the oracle spells
 * them.
 */
interface PydanticMeta {
  readonly type: string;
  readonly msg: string;
  readonly ctx?: Record<string, unknown>;
}

/** Key under which {@link PydanticMeta} travels inside `issue.params`. */
const META_KEY = "pydantic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recovers {@link PydanticMeta} from an issue's `params`, if present.
 *
 * Narrowed at runtime rather than cast, so a malformed params object degrades to
 * "no metadata" instead of throwing while an error is being reported.
 */
function readPydanticMeta(params: unknown): PydanticMeta | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const raw = params[META_KEY];
  if (!isRecord(raw)) {
    return undefined;
  }
  const { type, msg, ctx } = raw;
  if (typeof type !== "string" || typeof msg !== "string") {
    return undefined;
  }
  return isRecord(ctx) ? { type, msg, ctx } : { type, msg };
}

/** Adds one Pydantic-metadata issue to `ctx` and aborts the schema. */
function fail(ctx: z.core.$RefinementCtx, meta: PydanticMeta): never {
  ctx.addIssue({
    code: "custom",
    message: meta.msg,
    params: { [META_KEY]: meta },
  });
  return z.NEVER;
}

/**
 * Wraps a hand-written validator as a Zod schema.
 *
 * Input is `unknown` so the validator — not Zod — decides what happens for every
 * JSON value. That is what lets a primitive report Pydantic's `missing` for an
 * absent key while reporting a precise type error for a present one.
 */
function scalar<T>(validate: (value: unknown, failHere: (meta: PydanticMeta) => never) => T): z.ZodType<T> {
  return z.unknown().transform((value, ctx) => {
    const failHere = (meta: PydanticMeta): never => fail(ctx, meta);
    return validate(value, failHere);
  });
}

// ---------------------------------------------------------------------------
// Pydantic message catalogue
// ---------------------------------------------------------------------------

const MISSING: PydanticMeta = { type: "missing", msg: "Field required" };

const STRING_TYPE: PydanticMeta = { type: "string_type", msg: "Input should be a valid string" };
const INT_TYPE: PydanticMeta = { type: "int_type", msg: "Input should be a valid integer" };
const INT_PARSING: PydanticMeta = {
  type: "int_parsing",
  msg: "Input should be a valid integer, unable to parse string as an integer",
};
const INT_FROM_FLOAT: PydanticMeta = {
  type: "int_from_float",
  msg: "Input should be a valid integer, got a number with a fractional part",
};
const FLOAT_TYPE: PydanticMeta = { type: "float_type", msg: "Input should be a valid number" };
const FLOAT_PARSING: PydanticMeta = {
  type: "float_parsing",
  msg: "Input should be a valid number, unable to parse string as a number",
};
const BOOL_TYPE: PydanticMeta = { type: "bool_type", msg: "Input should be a valid boolean" };
const BOOL_PARSING: PydanticMeta = {
  type: "bool_parsing",
  msg: "Input should be a valid boolean, unable to interpret input",
};
const DICT_TYPE: PydanticMeta = { type: "dict_type", msg: "Input should be a valid dictionary" };
const LIST_TYPE: PydanticMeta = { type: "list_type", msg: "Input should be a valid list" };
const UUID_TYPE: PydanticMeta = {
  type: "uuid_type",
  msg: "UUID input should be a string, bytes or UUID object",
};
const MODEL_ATTRIBUTES_TYPE: PydanticMeta = {
  type: "model_attributes_type",
  msg: "Input should be a valid dictionary or object to extract fields from",
};

/** Pydantic says "1 character" but "200 characters". */
function characters(count: number): string {
  return count === 1 ? "character" : "characters";
}

function stringTooShort(minLength: number): PydanticMeta {
  return {
    type: "string_too_short",
    msg: `String should have at least ${String(minLength)} ${characters(minLength)}`,
    ctx: { min_length: minLength },
  };
}

function stringTooLong(maxLength: number): PydanticMeta {
  return {
    type: "string_too_long",
    msg: `String should have at most ${String(maxLength)} ${characters(maxLength)}`,
    ctx: { max_length: maxLength },
  };
}

function stringPatternMismatch(pattern: string): PydanticMeta {
  return {
    type: "string_pattern_mismatch",
    msg: `String should match pattern '${pattern}'`,
    ctx: { pattern },
  };
}

function uuidParsing(reason: string): PydanticMeta {
  return {
    type: "uuid_parsing",
    msg: `Input should be a valid UUID, ${reason}`,
    ctx: { error: reason },
  };
}

/**
 * Pydantic's `literal_error` text for a set of allowed values.
 *
 * Measured against the oracle:
 *   two values   -> `Input should be 'run' or 'direct'`
 *   three values -> `Input should be 'stack', 'workspace' or 'domain'`
 *
 * `ctx.expected` is that same text minus the leading capital of "Input", i.e.
 * the quoted list on its own.
 */
function literalExpected(values: readonly unknown[]): string {
  const quoted = values.map((value) => `'${String(value)}'`);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  const head = quoted.slice(0, -1).join(", ");
  const tail = quoted[quoted.length - 1] ?? "";
  return `${head} or ${tail}`;
}

function literalError(values: readonly unknown[]): PydanticMeta {
  const expected = literalExpected(values);
  return { type: "literal_error", msg: `Input should be ${expected}`, ctx: { expected } };
}

function boundError(bound: number, kind: "ge" | "gt" | "le" | "lt"): PydanticMeta {
  switch (kind) {
    case "ge":
      return {
        type: "greater_than_equal",
        msg: `Input should be greater than or equal to ${String(bound)}`,
        ctx: { ge: bound },
      };
    case "gt":
      return {
        type: "greater_than",
        msg: `Input should be greater than ${String(bound)}`,
        ctx: { gt: bound },
      };
    case "le":
      return {
        type: "less_than_equal",
        msg: `Input should be less than or equal to ${String(bound)}`,
        ctx: { le: bound },
      };
    case "lt":
      return { type: "less_than", msg: `Input should be less than ${String(bound)}`, ctx: { lt: bound } };
  }
}

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

/** Canonical lengths of the five UUID groups, in order. */
const UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;
const UUID_SIMPLE_LENGTH = 32;
const UUID_HYPHENATED_LENGTH = 36;
const URN_UUID_PREFIX = "urn:uuid:";
const MAX_UUID_TEXT_LENGTH = 45;

const NON_HEX_RE = /[^0-9a-fA-F]/;

type UuidParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/** `8-4-4-4-12` from 32 bare hex characters, lowercased. */
function formatSimpleUuid(simple: string): string {
  return [
    simple.slice(0, 8),
    simple.slice(8, 12),
    simple.slice(12, 16),
    simple.slice(16, 20),
    simple.slice(20),
  ]
    .join("-")
    .toLowerCase();
}

/**
 * Reproduces the Rust `uuid` parser Pydantic delegates to, including the text of
 * its `Error` variants, because `uuid_parsing` embeds that text in both `msg` and
 * `ctx.error`.
 *
 * The dispatch matches all 212 probes taken against the live oracle:
 *
 * 1. longer than 45 characters -> `invalid length: found N`
 * 2. **at exactly 36 characters, skip step 3**: the strict hyphenated path is
 *    attempted on the raw text. This is why `{8-4-4-4-12}`-shaped input whose
 *    total length is 36 reports ``invalid character: found `{` at 0`` rather
 *    than a group count — the wrapper is never stripped.
 * 3. otherwise strip a `{...}` wrapper or an `urn:uuid:` prefix
 * 4. first character that is neither hex nor `-` ->
 *    ``invalid character: found `c` at N``, indexed against the *original*
 *    string so a wrapper's offset is included
 * 5. exactly five groups -> per-group length checks, then accept
 * 6. more than one group but not five -> `invalid group count`
 * 7. a bare 32 characters -> simple form
 * 8. a stripped input with one group -> `invalid group count: … found 1`
 * 9. otherwise -> `invalid length: found N`
 *
 * Accepted forms are therefore `32 hex`, `8-4-4-4-12`, `{8-4-4-4-12}` and
 * `urn:uuid:8-4-4-4-12`, matching Pydantic. Version and variant nibbles are not
 * constrained, unlike RFC-strict validators, because Pydantic does not constrain
 * them.
 */
function parseUuidText(input: string): UuidParse {
  const originalLength = input.length;
  if (originalLength > MAX_UUID_TEXT_LENGTH) {
    return { ok: false, reason: `invalid length: found ${String(originalLength)}` };
  }

  let inner = input;
  let offset = 0;
  let stripped = false;
  // Length 36 is attempted verbatim, before any wrapper is considered: the
  // strict hyphenated form is exactly 36 characters, so the parser tries that
  // first and never reaches the wrapper handling.
  if (originalLength !== UUID_HYPHENATED_LENGTH) {
    if (inner.startsWith("{") && inner.endsWith("}")) {
      inner = inner.slice(1, -1);
      offset = 1;
      stripped = true;
    } else if (inner.startsWith(URN_UUID_PREFIX)) {
      inner = inner.slice(URN_UUID_PREFIX.length);
      offset = URN_UUID_PREFIX.length;
      stripped = true;
    }
  }

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner.charAt(index);
    if (char !== "-" && NON_HEX_RE.test(char)) {
      return {
        ok: false,
        reason: `invalid character: found \`${char}\` at ${String(offset + index)}`,
      };
    }
  }

  const groups = inner.split("-");

  if (groups.length === 5) {
    for (let group = 0; group < UUID_GROUP_LENGTHS.length; group += 1) {
      const expected = UUID_GROUP_LENGTHS[group] ?? 0;
      const found = groups[group]?.length ?? 0;
      if (found !== expected) {
        return {
          ok: false,
          reason: `invalid group length in group ${String(group)}: expected ${String(expected)}, found ${String(found)}`,
        };
      }
    }
    return { ok: true, value: inner.toLowerCase() };
  }

  if (groups.length > 1) {
    return {
      ok: false,
      reason: `invalid group count: expected 5, found ${String(groups.length)}`,
    };
  }

  // A single group: the 32-character simple form, an unstripped 36-character
  // blob (which the strict path already rejected), a stripped wrapper with no
  // hyphens, or simply not a UUID.
  if (!stripped && originalLength === UUID_SIMPLE_LENGTH) {
    return { ok: true, value: formatSimpleUuid(inner) };
  }
  if (stripped || originalLength === UUID_HYPHENATED_LENGTH) {
    return { ok: false, reason: `invalid group count: expected 5, found 1` };
  }
  return { ok: false, reason: `invalid length: found ${String(originalLength)}` };
}

/**
 * `uuid.UUID`.
 *
 * Resolves to the **canonical lowercase hyphenated** form, which is what
 * Pydantic serializes: the oracle answers
 * `/stacks/366173423b684ea781b95bc562bb81d3` with
 * `Stack 36617342-3b68-4ea7-81b9-5bc562bb81d3 not found`.
 */
export function pydanticUuid(): z.ZodType<string> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }
    if (typeof value !== "string") {
      return failHere(UUID_TYPE);
    }
    const parsed = parseUuidText(value);
    if (!parsed.ok) {
      return failHere(uuidParsing(parsed.reason));
    }
    return parsed.value;
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

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

/** Reads `root` at `path`, or `undefined` when the path does not exist. */
function readAt(root: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[key];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * `input` for a Pydantic `missing` error.
 *
 * For a body field Pydantic reports the *parent* object (`{"name": "X"}` for a
 * missing `domain`), because that is the value handed to the field validator.
 * For `path` and `query` parameters it reports `null`, since the parameter was
 * never extracted into a container. Both were measured on the oracle.
 */
function missingInput(root: unknown, path: readonly (string | number)[], prefix: LocPrefix): unknown {
  if (prefix !== "body" || path.length === 0) {
    return null;
  }
  const parent = readAt(root, path.slice(0, -1));
  return parent === undefined ? null : parent;
}

/** Normalizes Zod's `PropertyKey[]` into Pydantic's `(str | int)[]`. */
function normalizePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
}

/** Builds the final 422 entry, omitting `ctx` exactly when Pydantic omits it. */
function detail(
  meta: PydanticMeta,
  path: readonly (string | number)[],
  prefix: LocPrefix,
  root: unknown,
): PydanticErrorDetail {
  const loc = [prefix, ...path];
  const input = meta.type === "missing" ? missingInput(root, path, prefix) : readAt(root, path);
  return meta.ctx === undefined
    ? { type: meta.type, loc, msg: meta.msg, input }
    : { type: meta.type, loc, msg: meta.msg, input, ctx: meta.ctx };
}

/** Maps Zod's `invalid_type` expectation onto Pydantic's type errors. */
function typeErrorMeta(expected: string): PydanticMeta {
  switch (expected) {
    case "string":
      return STRING_TYPE;
    case "boolean":
      return BOOL_TYPE;
    case "int":
      return INT_TYPE;
    case "number":
      // Zod reports both `z.number()` and `z.int()` as "number" for a
      // non-numeric value. The DTO primitives never reach this path; they tag
      // their own issues with the exact `int_*` / `float_*` code.
      return FLOAT_TYPE;
    case "object":
      return MODEL_ATTRIBUTES_TYPE;
    case "record":
      return DICT_TYPE;
    case "array":
      return LIST_TYPE;
    default:
      return { type: "value_error", msg: `Input should be a valid ${expected}` };
  }
}

/** Translates Zod's `too_small` / `too_big` checks. */
function sizeMeta(
  issue: { readonly origin?: string; readonly inclusive?: boolean },
  size: number,
  kind: "small" | "big",
): PydanticMeta {
  const inclusive = issue.inclusive !== false;
  switch (issue.origin) {
    case "string":
      return kind === "small" ? stringTooShort(size) : stringTooLong(size);
    case "array":
    case "set":
      return kind === "small"
        ? {
            type: "too_short",
            msg: `List should have at least ${String(size)} item${size === 1 ? "" : "s"} after validation, not fewer`,
            ctx: { min_length: size },
          }
        : {
            type: "too_long",
            msg: `List should have at most ${String(size)} item${size === 1 ? "" : "s"} after validation, not more`,
            ctx: { max_length: size },
          };
    default:
      return kind === "small" ? boundError(size, inclusive ? "ge" : "gt") : boundError(size, inclusive ? "le" : "lt");
  }
}

/**
 * Strips the `/source/flags` dressing Zod puts around `issue.pattern` so the
 * message can quote the pattern the way Pydantic does (`^[a-z0-9-]+$`). A
 * pattern containing a literal `/` is kept whole rather than truncated.
 */
function barePattern(zodPattern: string): string {
  const match = /^\/(.*)\/[a-z]*$/s.exec(zodPattern);
  return match?.[1] ?? zodPattern;
}

/** Pydantic's generic `Value error`, for issues with no faithful mapping. */
function valueError(message: string): PydanticMeta {
  return { type: "value_error", msg: `Value error, ${message}` };
}

/** Translates one Zod issue into one or more Pydantic details. */
function translate(issue: z.core.$ZodIssue, prefix: LocPrefix, root: unknown): PydanticErrorDetail[] {
  const path = normalizePath(issue.path);

  /**
   * A path that resolves to `undefined` means the key was absent — JSON has no
   * `undefined`, so this cannot mean "present but undefined". Pydantic reports
   * an absent field as `missing` regardless of which constraint Zod tripped on,
   * so this check runs before any code-specific translation. It is what makes
   * `z.literal`, which raises `invalid_value` for a missing key, come out as
   * `missing` like the oracle.
   */
  if (readAt(root, path) === undefined) {
    return [detail(MISSING, path, prefix, root)];
  }

  switch (issue.code) {
    case "custom":
      return [detail(readPydanticMeta(issue.params) ?? valueError(issue.message), path, prefix, root)];
    case "invalid_type":
      return [detail(typeErrorMeta(String(issue.expected)), path, prefix, root)];
    case "too_small":
      return [detail(sizeMeta(issue, Number(issue.minimum), "small"), path, prefix, root)];
    case "too_big":
      return [detail(sizeMeta(issue, Number(issue.maximum), "big"), path, prefix, root)];
    case "invalid_format":
      return [
        detail(
          issue.format === "regex"
            ? stringPatternMismatch(barePattern(issue.pattern ?? ""))
            : valueError(issue.message),
          path,
          prefix,
          root,
        ),
      ];
    case "invalid_value":
      return [detail(literalError(issue.values), path, prefix, root)];
    case "not_multiple_of":
      return [
        detail(
          {
            type: "multiple_of",
            msg: `Input should be a multiple of ${String(issue.divisor)}`,
            ctx: { multiple_of: issue.divisor },
          },
          path,
          prefix,
          root,
        ),
      ];
    case "invalid_union": {
      /**
       * Zod collapses a failed union into one issue carrying every branch's
       * errors; Pydantic has no union-level error. The first non-empty branch is
       * used. The DTOs contain no unions, so this path exists mainly so an
       * unexpected one still degrades to a real Pydantic code rather than
       * leaking a Zod message.
       */
      const branch = issue.errors.find((errors) => errors.length > 0) ?? [];
      return branch.flatMap((nested) =>
        translate({ ...nested, path: [...issue.path, ...nested.path] }, prefix, root),
      );
    }
    case "invalid_element":
    case "invalid_key":
      return issue.issues.flatMap((nested) =>
        translate({ ...nested, path: [...issue.path, ...nested.path] }, prefix, root),
      );
    case "unrecognized_keys":
    default:
      return [detail(valueError(issue.message), path, prefix, root)];
  }
}

/**
 * Rewrites a `ZodError` into FastAPI's 422 body.
 *
 * @param err - the error from `schema.parse` or `schema.safeParse(...).error`.
 * @param loc - where the value came from. FastAPI prefixes every `loc` with it.
 * @param input - the *raw, unparsed* value that was validated. Needed to
 *   reproduce `input` exactly: the parent object Pydantic reports for `missing`,
 *   and the untouched string Pydantic reports for a failed query-parameter cast
 *   (`"0"`, never `0`).
 *
 * ## Ordering
 *
 * Entries keep Zod's own issue order, which is:
 *
 * 1. the object's schema declaration order — the DTOs declare fields in the same
 *    order as `app/models/api.py`, so that is Pydantic's declaration order;
 * 2. then array index order within a nested list;
 * 3. then constraint order within a single field.
 *
 * That order is deterministic and matches the oracle. Nothing is sorted, so a
 * schema whose declaration order drifts from the Python model surfaces as a diff
 * instead of being papered over.
 */
export function toFastApiValidationError(
  err: z.ZodError,
  loc: LocPrefix,
  input: unknown,
): ValidationFailure {
  const details: PydanticErrorDetail[] = [];
  for (const issue of err.issues) {
    details.push(...translate(issue, loc, input));
  }
  return { status: 422, body: { detail: details } };
}
