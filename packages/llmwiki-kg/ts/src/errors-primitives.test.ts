/**
 * @file packages/llmwiki-kg/ts/src/errors-primitives.test.ts
 * @description Primitive type errors and numeric bounds.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { pydanticBoolean, pydanticDict, pydanticFloat, pydanticInt, pydanticString } from "./errors.js";

import { onlyDetail } from "./errors-harness.js";

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
