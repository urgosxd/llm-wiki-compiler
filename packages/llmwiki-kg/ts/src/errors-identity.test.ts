/**
 * @file packages/llmwiki-kg/ts/src/errors-identity.test.ts
 * @description UUID parsing and `loc` prefix handling.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { pydanticInt, pydanticString, pydanticUuid, toFastApiValidationError } from "./errors.js";

import { assertNever, onlyDetail } from "./errors-harness.js";

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
