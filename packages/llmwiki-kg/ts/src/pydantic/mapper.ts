/**
 * @file packages/llmwiki-kg/ts/src/pydantic/mapper.ts
 * @description Rewrites a `ZodError` into FastAPI's `422 {"detail": [...]}` body.
 *
 * The mapper prefers the Pydantic metadata a primitive attached in
 * `issue.params`; only issues raised by plain Zod schemas (`z.object`,
 * `z.array`, `z.literal`) fall back to generic translation, because those
 * already line up with Pydantic's `model_attributes_type` / `list_type` /
 * `literal_error` shapes.
 *
 * FastAPI's `loc` is `[prefix, ...path]`, with a synthesized entry for a missing
 * field the submitted body never contained. Reproducing that needs the ORIGINAL
 * input, which is why `toFastApiValidationError` takes `root` as well as the error.
 */

import { z } from "zod";

import {
  BOOL_TYPE,
  DICT_TYPE,
  FLOAT_TYPE,
  INT_TYPE,
  LIST_TYPE,
  MISSING,
  MODEL_ATTRIBUTES_TYPE,
  STRING_TYPE,
  type PydanticMeta,
  boundError,
  isRecord,
  literalError,
  readPydanticMeta,
  stringPatternMismatch,
  stringTooLong,
  stringTooShort,
} from "./pydantic-meta.js";
import type {
  LocPrefix,
  PydanticErrorDetail,
  ValidationFailure,
} from "./wire.js";

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
/** Translate a failed union by taking its first non-empty branch. */
function translateUnion(issue: z.core.$ZodIssue & { errors: z.core.$ZodIssue[][] }, prefix: LocPrefix, root: unknown): PydanticErrorDetail[] {
  /**
   * Zod collapses a failed union into one issue carrying every branch's errors;
   * Pydantic has no union-level error. The first non-empty branch is used. The
   * DTOs contain no unions, so this path exists mainly so an unexpected one
   * still degrades to a real Pydantic code rather than leaking a Zod message.
   */
  const branch = issue.errors.find((errors) => errors.length > 0) ?? [];
  return branch.flatMap((nested) =>
    translate({ ...nested, path: [...issue.path, ...nested.path] }, prefix, root),
  );
}

/** Translate a format issue, keeping Pydantic's regex wording. */
function formatMeta(issue: z.core.$ZodIssue & { format?: string; pattern?: string }): PydanticMeta {
  return issue.format === "regex"
    ? stringPatternMismatch(barePattern(issue.pattern ?? ""))
    : valueError(issue.message);
}

/** The `multiple_of` error Pydantic raises; Zod carries only the divisor. */
function multipleOfMeta(divisor: number): PydanticMeta {
  return {
    type: "multiple_of",
    msg: `Input should be a multiple of ${String(divisor)}`,
    ctx: { multiple_of: divisor },
  };
}

/** Translate one non-custom Zod issue code into a Pydantic meta. */
function translateByCode(issue: z.core.$ZodIssue): PydanticMeta {
  switch (issue.code) {
    case "invalid_type":
      return typeErrorMeta(String(issue.expected));
    case "too_small":
      return sizeMeta(issue, Number(issue.minimum), "small");
    case "too_big":
      return sizeMeta(issue, Number(issue.maximum), "big");
    case "invalid_format":
      return formatMeta(issue);
    case "invalid_value":
      return literalError(issue.values);
    case "not_multiple_of":
      return multipleOfMeta(Number(issue.divisor));
    default:
      return valueError(issue.message);
  }
}

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

  // Nested-container codes recurse instead of mapping to a single meta.
  if (issue.code === "invalid_union") {
    return translateUnion(issue as z.core.$ZodIssue & { errors: z.core.$ZodIssue[][] }, prefix, root);
  }
  if (issue.code === "invalid_element" || issue.code === "invalid_key") {
    return issue.issues.flatMap((nested) =>
      translate({ ...nested, path: [...issue.path, ...nested.path] }, prefix, root),
    );
  }

  const meta =
    issue.code === "custom"
      ? readPydanticMeta(issue.params) ?? valueError(issue.message)
      : translateByCode(issue);
  return [detail(meta, path, prefix, root)];
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
