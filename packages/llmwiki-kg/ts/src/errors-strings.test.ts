/**
 * @file packages/llmwiki-kg/ts/src/errors-strings.test.ts
 * @description String constraints, missing fields and literal errors.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { pydanticString, pydanticUuid } from "./errors.js";

import { mapFailure, onlyDetail } from "./errors-harness.js";

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
