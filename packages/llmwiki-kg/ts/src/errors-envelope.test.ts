/**
 * @file packages/llmwiki-kg/ts/src/errors-envelope.test.ts
 * @description Detail-entry ordering and `apiError` envelope shape.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiError, pydanticString, toFastApiValidationError } from "./errors.js";

import { assertNever } from "./errors-harness.js";

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
