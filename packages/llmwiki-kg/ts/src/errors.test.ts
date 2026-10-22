import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { StackCreate } from "./dto.js";
import {
  apiError,
  pydanticBoolean,
  pydanticDict,
  pydanticFloat,
  pydanticInt,
  pydanticString,
  pydanticUuid,
  toFastApiValidationError,
  type LocPrefix,
  type PydanticErrorDetail,
} from "./errors.js";

/** Directory of the oracle fixtures, resolved from this file. */
const ORACLE_DIR = fileURLToPath(new URL("../oracle/contracts/", import.meta.url));

interface CorpusCase {
  readonly id: string;
  readonly body: unknown;
}

interface ExpectedResult {
  readonly id: string;
  readonly status: number;
  readonly response: unknown;
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, `file://${ORACLE_DIR}`), "utf8")) as T;
}

const CORPUS = readJson<{ cases: CorpusCase[] }>("validation-422-corpus.json").cases;
const EXPECTED = readJson<{ results: ExpectedResult[] }>("validation-422-expected.json").results;

/** Looks up the oracle's recorded response for a corpus case. */
function oracleResult(id: string): ExpectedResult {
  const found = EXPECTED.find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`oracle fixture is missing a result for case "${id}"`);
  }
  return found;
}

/** Parses `body` with `schema` and maps the failure, or throws if it passes. */
function mapFailure(schema: z.ZodType, body: unknown, loc: LocPrefix = "body"): PydanticErrorDetail[] {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    throw new Error("expected the schema to reject the input");
  }
  return [...toFastApiValidationError(parsed.error, loc, body).body.detail];
}

/** Maps a failure and asserts it produced exactly one detail entry. */
function onlyDetail(schema: z.ZodType, body: unknown, loc: LocPrefix = "body"): PydanticErrorDetail {
  const details = mapFailure(schema, body, loc);
  expect(details).toHaveLength(1);
  const [first] = details;
  if (first === undefined) {
    throw new Error("expected one detail entry");
  }
  return first;
}

describe("corpus replay against the recorded oracle responses", () => {
  it("has a recorded oracle response for every corpus case", () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    for (const corpusCase of CORPUS) {
      expect(oracleResult(corpusCase.id).id).toBe(corpusCase.id);
    }
  });

  // The two 201 cases exist to prove the corpus itself is honest: they are
  // bodies the oracle accepted, so a mapper that rejected them would be wrong.
  const accepted = CORPUS.filter((corpusCase) => oracleResult(corpusCase.id).status === 201);
  const rejected = CORPUS.filter((corpusCase) => oracleResult(corpusCase.id).status === 422);

  it("covers both accepted and rejected cases", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it.each(accepted.map((corpusCase) => [corpusCase.id, corpusCase] as const))(
    "accepts %s, which the oracle answered 201 for",
    (_id, corpusCase) => {
      const parsed = StackCreate.safeParse(corpusCase.body);
      expect(parsed.success, `expected ${corpusCase.id} to parse`).toBe(true);
    },
  );

  it.each(rejected.map((corpusCase) => [corpusCase.id, corpusCase] as const))(
    "reproduces the oracle's 422 body for %s",
    (id, corpusCase) => {
      const expected = oracleResult(id);
      const parsed = StackCreate.safeParse(corpusCase.body);
      expect(parsed.success).toBe(false);
      if (parsed.success) {
        return;
      }

      const mapped = toFastApiValidationError(parsed.error, "body", corpusCase.body);

      // Compared against the fixture, never against a hardcoded string, so this
      // test stays honest if the corpus is ever regenerated.
      expect(mapped.status).toBe(422);
      expect(mapped.body).toEqual(expected.response);
    },
  );
});

describe("string constraint errors", () => {
  it("reports string_too_short with its min_length ctx", () => {
    const schema = z.object({ name: pydanticString({ minLength: 1 }) });
    expect(onlyDetail(schema, { name: "" })).toEqual({
      type: "string_too_short",
      loc: ["body", "name"],
      msg: "String should have at least 1 character",
      input: "",
      ctx: { min_length: 1 },
    });
  });

  it("pluralizes the message when the bound is not 1", () => {
    const schema = z.object({ name: pydanticString({ minLength: 3 }) });
    expect(onlyDetail(schema, { name: "ab" }).msg).toBe("String should have at least 3 characters");
  });

  it("reports string_too_long with its max_length ctx", () => {
    const schema = z.object({ name: pydanticString({ maxLength: 200 }) });
    const detail = onlyDetail(schema, { name: "x".repeat(201) });
    expect(detail.type).toBe("string_too_long");
    expect(detail.msg).toBe("String should have at most 200 characters");
    expect(detail.ctx).toEqual({ max_length: 200 });
  });

  it("reports string_pattern_mismatch with the bare pattern", () => {
    const schema = z.object({
      domain: pydanticString({ pattern: { regex: /^[a-z0-9-]+$/, source: "^[a-z0-9-]+$" } }),
    });
    expect(onlyDetail(schema, { domain: "NOT-A-SLUG" })).toEqual({
      type: "string_pattern_mismatch",
      loc: ["body", "domain"],
      msg: "String should match pattern '^[a-z0-9-]+$'",
      input: "NOT-A-SLUG",
      ctx: { pattern: "^[a-z0-9-]+$" },
    });
  });

  it("stops at the first failing constraint, like Pydantic", () => {
    // "" violates both min_length and pattern; Pydantic reports only the first.
    const schema = z.object({
      domain: pydanticString({ minLength: 1, pattern: { regex: /^[a-z]+$/, source: "^[a-z]+$" } }),
    });
    const details = mapFailure(schema, { domain: "" });
    expect(details).toHaveLength(1);
    expect(details[0]?.type).toBe("string_too_short");
  });

  it("quotes a pattern containing a slash instead of truncating it", () => {
    const schema = z.object({
      path: pydanticString({ pattern: { regex: /^a\/b$/, source: "^a/b$" } }),
    });
    expect(onlyDetail(schema, { path: "zzz" }).msg).toBe("String should match pattern '^a/b$'");
  });
});

describe("missing fields", () => {
  it("reports missing with the whole parent object as input", () => {
    const schema = z.object({ name: pydanticString(), domain: pydanticString() });
    expect(onlyDetail(schema, { name: "X" })).toEqual({
      type: "missing",
      loc: ["body", "domain"],
      msg: "Field required",
      input: { name: "X" },
    });
  });

  it("omits ctx entirely for missing", () => {
    const schema = z.object({ name: pydanticString() });
    expect(onlyDetail(schema, {})).not.toHaveProperty("ctx");
  });

  it("reports null for path and query parameters, which had no container", () => {
    const schema = z.object({ start: pydanticString() });
    const pathDetail = onlyDetail(schema, {}, "path");
    expect(pathDetail).toEqual({
      type: "missing",
      loc: ["path", "start"],
      msg: "Field required",
      input: null,
    });
    expect(onlyDetail(schema, {}, "query").input).toBeNull();
  });

  it("reports a nested missing field with its own parent object as input", () => {
    const schema = z.object({
      proposal: z.object({ entities: z.array(z.object({ name: pydanticString() })) }),
    });
    expect(onlyDetail(schema, { proposal: { entities: [{ type: "b" }] } })).toEqual({
      type: "missing",
      loc: ["body", "proposal", "entities", 0, "name"],
      msg: "Field required",
      input: { type: "b" },
    });
  });

  it("reports a missing root body as a single missing entry", () => {
    const schema = z.object({ item_id: pydanticUuid() });
    expect(onlyDetail(schema, {})).toEqual({
      type: "missing",
      loc: ["body", "item_id"],
      msg: "Field required",
      input: {},
    });
  });
});

describe("literal errors", () => {
  it("joins three values with commas and 'or'", () => {
    const schema = z.object({ scope: z.literal(["stack", "workspace", "domain"]) });
    expect(onlyDetail(schema, { scope: "INVALID" })).toEqual({
      type: "literal_error",
      loc: ["body", "scope"],
      msg: "Input should be 'stack', 'workspace' or 'domain'",
      input: "INVALID",
      ctx: { expected: "'stack', 'workspace' or 'domain'" },
    });
  });

  it("joins two values with 'or' and no comma", () => {
    const schema = z.object({ origin: z.literal(["run", "direct"]) });
    expect(onlyDetail(schema, { origin: "BAD" })).toEqual({
      type: "literal_error",
      loc: ["body", "origin"],
      msg: "Input should be 'run' or 'direct'",
      input: "BAD",
      ctx: { expected: "'run' or 'direct'" },
    });
  });

  it("joins three values for trigger_type", () => {
    const schema = z.object({ trigger_type: z.literal(["manual", "auto", "api"]) });
    expect(onlyDetail(schema, { trigger_type: "BAD" }).msg).toBe(
      "Input should be 'manual', 'auto' or 'api'",
    );
  });

  it("reports a literal error for an explicit null", () => {
    const schema = z.object({ scope: z.literal(["stack", "workspace", "domain"]) });
    expect(onlyDetail(schema, { scope: null }).type).toBe("literal_error");
  });
});

describe("primitive type errors", () => {
  it("reports string_type for a non-string body value", () => {
    const schema = z.object({ name: pydanticString() });
    expect(onlyDetail(schema, { name: 123 })).toEqual({
      type: "string_type",
      loc: ["body", "name"],
      msg: "Input should be a valid string",
      input: 123,
    });
  });

  it("reports int_parsing for an unparseable integer string", () => {
    const schema = z.object({ max_entities: pydanticInt() });
    expect(onlyDetail(schema, { max_entities: "abc" })).toEqual({
      type: "int_parsing",
      loc: ["body", "max_entities"],
      msg: "Input should be a valid integer, unable to parse string as an integer",
      input: "abc",
    });
  });

  it("reports int_parsing for a string with a fractional part", () => {
    const schema = z.object({ limit: pydanticInt() });
    expect(onlyDetail(schema, { limit: "1.5" }).type).toBe("int_parsing");
  });

  it("reports int_from_float for a JSON float with a fractional part", () => {
    const schema = z.object({ max_entities: pydanticInt() });
    expect(onlyDetail(schema, { max_entities: 1.5 })).toEqual({
      type: "int_from_float",
      loc: ["body", "max_entities"],
      msg: "Input should be a valid integer, got a number with a fractional part",
      input: 1.5,
    });
  });

  it("accepts a float that has no fractional part", () => {
    const schema = z.object({ max_entities: pydanticInt() });
    expect(schema.parse({ max_entities: 5.0 })).toEqual({ max_entities: 5 });
  });

  it("reports int_type for an explicit null", () => {
    const schema = z.object({ max_entities: pydanticInt() });
    expect(onlyDetail(schema, { max_entities: null })).toEqual({
      type: "int_type",
      loc: ["body", "max_entities"],
      msg: "Input should be a valid integer",
      input: null,
    });
  });

  it("reports bool_type for an explicit null", () => {
    const schema = z.object({ flag: pydanticBoolean() });
    expect(onlyDetail(schema, { flag: null }).type).toBe("bool_type");
  });

  it("reports bool_parsing for an uninterpretable string", () => {
    const schema = z.object({ flag: pydanticBoolean() });
    expect(onlyDetail(schema, { flag: "maybe" })).toEqual({
      type: "bool_parsing",
      loc: ["body", "flag"],
      msg: "Input should be a valid boolean, unable to interpret input",
      input: "maybe",
    });
  });

  it("reports bool_parsing for a number other than 0 or 1", () => {
    const schema = z.object({ flag: pydanticBoolean() });
    expect(onlyDetail(schema, { flag: 2 }).type).toBe("bool_parsing");
  });

  it("reports float_type for an explicit null and float_parsing for a bad string", () => {
    const schema = z.object({ confidence: pydanticFloat() });
    expect(onlyDetail(schema, { confidence: null }).type).toBe("float_type");
    expect(onlyDetail(schema, { confidence: "x" })).toEqual({
      type: "float_parsing",
      loc: ["body", "confidence"],
      msg: "Input should be a valid number, unable to parse string as a number",
      input: "x",
    });
  });

  it("reports dict_type for a non-object", () => {
    const schema = z.object({ metadata: pydanticDict() });
    expect(onlyDetail(schema, { metadata: [1, 2] })).toEqual({
      type: "dict_type",
      loc: ["body", "metadata"],
      msg: "Input should be a valid dictionary",
      input: [1, 2],
    });
    expect(onlyDetail(schema, { metadata: null }).type).toBe("dict_type");
  });

  it("reports list_type for a non-list", () => {
    const schema = z.object({ entities: z.array(z.string()) });
    expect(onlyDetail(schema, { entities: "no" })).toEqual({
      type: "list_type",
      loc: ["body", "entities"],
      msg: "Input should be a valid list",
      input: "no",
    });
  });

  it("reports model_attributes_type when a nested model receives a non-object", () => {
    const schema = z.object({ proposal: z.object({ note: pydanticString() }) });
    expect(onlyDetail(schema, { proposal: 5 })).toEqual({
      type: "model_attributes_type",
      loc: ["body", "proposal"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: 5,
    });
  });
});

describe("numeric bounds", () => {
  it("reports greater_than_equal with its ge ctx", () => {
    const schema = z.object({ max_entities: pydanticInt({ ge: 1 }) });
    expect(onlyDetail(schema, { max_entities: 0 })).toEqual({
      type: "greater_than_equal",
      loc: ["body", "max_entities"],
      msg: "Input should be greater than or equal to 1",
      input: 0,
      ctx: { ge: 1 },
    });
  });

  it("reports less_than_equal with its le ctx", () => {
    const schema = z.object({ max_entities: pydanticInt({ le: 50 }) });
    expect(onlyDetail(schema, { max_entities: 99 })).toEqual({
      type: "less_than_equal",
      loc: ["body", "max_entities"],
      msg: "Input should be less than or equal to 50",
      input: 99,
      ctx: { le: 50 },
    });
  });

  it("reports float bounds against the recorded confidence limits", () => {
    const schema = z.object({ confidence: pydanticFloat({ ge: 0, le: 1 }) });
    expect(onlyDetail(schema, { confidence: -0.5 })).toEqual({
      type: "greater_than_equal",
      loc: ["body", "confidence"],
      msg: "Input should be greater than or equal to 0",
      input: -0.5,
      ctx: { ge: 0 },
    });
    expect(onlyDetail(schema, { confidence: 2.5 }).type).toBe("less_than_equal");
  });
});

describe("UUID parsing", () => {
  it("accepts every text form Pydantic accepts and canonicalizes it", () => {
    const schema = pydanticUuid();
    const canonical = "01234567-89ab-cdef-0123-456789abcdef";
    for (const form of [
      canonical,
      canonical.toUpperCase(),
      "0123456789abcdef0123456789abcdef",
      `{${canonical}}`,
      `urn:uuid:${canonical}`,
    ]) {
      expect(schema.parse(form), `expected ${form} to parse`).toBe(canonical);
    }
  });

  it("accepts a UUID whose version and variant nibbles are not RFC-conforming", () => {
    // z.uuid() rejects this; Pydantic does not, and the oracle parses it.
    expect(pydanticUuid().parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
  });

  it("reports uuid_type for a non-string", () => {
    expect(onlyDetail(z.object({ id: pydanticUuid() }), { id: 123 })).toEqual({
      type: "uuid_type",
      loc: ["body", "id"],
      msg: "UUID input should be a string, bytes or UUID object",
      input: 123,
    });
  });

  it.each([
    ["abc", "invalid length: found 3"],
    ["zzz", "invalid character: found `z` at 0"],
    ["-zzz", "invalid character: found `z` at 1"],
    ["not-a-uuid", "invalid character: found `n` at 0"],
    ["0123456789abcdef0123456789abcdef0123", "invalid group count: expected 5, found 1"],
    ["01234567-89ab-cdef-0123-456789abcde", "invalid group length in group 4: expected 12, found 11"],
    ["012345-6789abcdef-cdef-0123-456789abcdef", "invalid group length in group 0: expected 8, found 6"],
    ["{zzz}", "invalid character: found `z` at 1"],
    ["urn:uuid:zz", "invalid character: found `z` at 9"],
    ["01234567-89ab-cdef-0123-456789abcdef-", "invalid group count: expected 5, found 6"],
  ])("reports the Rust uuid reason for %s", (input, reason) => {
    expect(onlyDetail(z.object({ id: pydanticUuid() }), { id: input })).toEqual({
      type: "uuid_parsing",
      loc: ["body", "id"],
      msg: `Input should be a valid UUID, ${reason}`,
      input,
      ctx: { error: reason },
    });
  });
});

describe("loc prefixes", () => {
  it.each(["body", "path", "query"] as const)("prefixes every loc with %s", (prefix) => {
    const schema = z.object({ value: pydanticString({ minLength: 1 }) });
    const mapped = toFastApiValidationError(schema.safeParse({ value: "" }).error ?? assertNever(), prefix, {
      value: "",
    });
    expect(mapped.body.detail[0]?.loc).toEqual([prefix, "value"]);
  });

  it("keeps the raw query string in input rather than a coerced value", () => {
    // FastAPI never coerces before failing, so `input` is the literal "0".
    const schema = z.object({ limit: pydanticInt({ ge: 1 }) });
    expect(onlyDetail(schema, { limit: "0" }, "query")).toEqual({
      type: "greater_than_equal",
      loc: ["query", "limit"],
      msg: "Input should be greater than or equal to 1",
      input: "0",
      ctx: { ge: 1 },
    });
  });
});

describe("ordering", () => {
  it("keeps schema declaration order across multiple failures", () => {
    const schema = z.object({
      name: pydanticString({ minLength: 1 }),
      domain: pydanticString({ pattern: { regex: /^[a-z0-9-]+$/, source: "^[a-z0-9-]+$" } }),
      scope: z.literal(["stack", "workspace", "domain"]),
      compilation_strategy: z.literal(["incremental", "global"]),
    });
    const mapped = toFastApiValidationError(
      schema.safeParse({
        name: "",
        domain: "BAD",
        scope: "X",
        compilation_strategy: "Y",
      }).error ?? assertNever(),
      "body",
      { name: "", domain: "BAD", scope: "X", compilation_strategy: "Y" },
    );
    expect(mapped.body.detail.map((entry) => entry.loc)).toEqual([
      ["body", "name"],
      ["body", "domain"],
      ["body", "scope"],
      ["body", "compilation_strategy"],
    ]);
  });

  it("keeps array index order within a nested list", () => {
    const schema = z.object({
      entities: z.array(z.object({ name: pydanticString() })),
    });
    const input = { entities: [{ name: 1 }, { name: 2 }] };
    const mapped = toFastApiValidationError(schema.safeParse(input).error ?? assertNever(), "body", input);
    expect(mapped.body.detail.map((entry) => entry.loc)).toEqual([
      ["body", "entities", 0, "name"],
      ["body", "entities", 1, "name"],
    ]);
  });
});

describe("apiError", () => {
  it("produces FastAPI's single-detail envelope", () => {
    expect(apiError(404, "Stack abc not found")).toEqual({
      status: 404,
      body: { detail: "Stack abc not found" },
    });
  });

  it("keeps detail a string, never an array", () => {
    expect(typeof apiError(409, "conflict").body.detail).toBe("string");
  });
});

/** Narrows away `undefined` in tests that require a failing parse. */
function assertNever(): never {
  throw new Error("expected the schema to reject the input");
}
