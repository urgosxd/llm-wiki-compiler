/**
 * @file packages/llmwiki-kg/ts/src/pydantic/pydantic-meta.ts
 * @description The Pydantic error vocabulary and the plumbing that attaches it
 * to a Zod issue.
 *
 * Every primitive reports exactly one Pydantic error. Rather than building each
 * `{type, msg, ctx}` inline, the catalogue below names them once so the wording
 * cannot drift between two primitives reporting the same condition — Pydantic is
 * the contract, and a re-worded message is a contract break.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Issue metadata protocol
// ---------------------------------------------------------------------------

/**
 * The Pydantic error a primitive wants reported. `type` is Pydantic's error
 * code, `msg` its message and `ctx` its optional context. All three are copied
 * into the 422 body verbatim, so they are spelled exactly as the oracle spells
 * them.
 */
export interface PydanticMeta {
  readonly type: string;
  readonly msg: string;
  readonly ctx?: Record<string, unknown>;
}

/** Key under which {@link PydanticMeta} travels inside `issue.params`. */
export const META_KEY = "pydantic";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recovers {@link PydanticMeta} from an issue's `params`, if present.
 *
 * Narrowed at runtime rather than cast, so a malformed params object degrades to
 * "no metadata" instead of throwing while an error is being reported.
 */
export function readPydanticMeta(params: unknown): PydanticMeta | undefined {
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
export function fail(ctx: z.core.$RefinementCtx, meta: PydanticMeta): never {
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
export function scalar<T>(validate: (value: unknown, failHere: (meta: PydanticMeta) => never) => T): z.ZodType<T> {
  return z.unknown().transform((value, ctx) => {
    const failHere = (meta: PydanticMeta): never => fail(ctx, meta);
    return validate(value, failHere);
  });
}

// ---------------------------------------------------------------------------
// Pydantic message catalogue
// ---------------------------------------------------------------------------

export const MISSING: PydanticMeta = { type: "missing", msg: "Field required" };

export const STRING_TYPE: PydanticMeta = { type: "string_type", msg: "Input should be a valid string" };
export const INT_TYPE: PydanticMeta = { type: "int_type", msg: "Input should be a valid integer" };
export const INT_PARSING: PydanticMeta = {
  type: "int_parsing",
  msg: "Input should be a valid integer, unable to parse string as an integer",
};
export const INT_FROM_FLOAT: PydanticMeta = {
  type: "int_from_float",
  msg: "Input should be a valid integer, got a number with a fractional part",
};
export const FLOAT_TYPE: PydanticMeta = { type: "float_type", msg: "Input should be a valid number" };
export const FLOAT_PARSING: PydanticMeta = {
  type: "float_parsing",
  msg: "Input should be a valid number, unable to parse string as a number",
};
export const BOOL_TYPE: PydanticMeta = { type: "bool_type", msg: "Input should be a valid boolean" };
export const BOOL_PARSING: PydanticMeta = {
  type: "bool_parsing",
  msg: "Input should be a valid boolean, unable to interpret input",
};
export const DICT_TYPE: PydanticMeta = { type: "dict_type", msg: "Input should be a valid dictionary" };
export const LIST_TYPE: PydanticMeta = { type: "list_type", msg: "Input should be a valid list" };
export const UUID_TYPE: PydanticMeta = {
  type: "uuid_type",
  msg: "UUID input should be a string, bytes or UUID object",
};
export const MODEL_ATTRIBUTES_TYPE: PydanticMeta = {
  type: "model_attributes_type",
  msg: "Input should be a valid dictionary or object to extract fields from",
};

/** Pydantic says "1 character" but "200 characters". */
export function characters(count: number): string {
  return count === 1 ? "character" : "characters";
}

export function stringTooShort(minLength: number): PydanticMeta {
  return {
    type: "string_too_short",
    msg: `String should have at least ${String(minLength)} ${characters(minLength)}`,
    ctx: { min_length: minLength },
  };
}

export function stringTooLong(maxLength: number): PydanticMeta {
  return {
    type: "string_too_long",
    msg: `String should have at most ${String(maxLength)} ${characters(maxLength)}`,
    ctx: { max_length: maxLength },
  };
}

export function stringPatternMismatch(pattern: string): PydanticMeta {
  return {
    type: "string_pattern_mismatch",
    msg: `String should match pattern '${pattern}'`,
    ctx: { pattern },
  };
}

export function uuidParsing(reason: string): PydanticMeta {
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
export function literalExpected(values: readonly unknown[]): string {
  const quoted = values.map((value) => `'${String(value)}'`);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  const head = quoted.slice(0, -1).join(", ");
  const tail = quoted[quoted.length - 1] ?? "";
  return `${head} or ${tail}`;
}

export function literalError(values: readonly unknown[]): PydanticMeta {
  const expected = literalExpected(values);
  return { type: "literal_error", msg: `Input should be ${expected}`, ctx: { expected } };
}

export function boundError(bound: number, kind: "ge" | "gt" | "le" | "lt"): PydanticMeta {
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
