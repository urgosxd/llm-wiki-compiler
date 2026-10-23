/**
 * @file packages/llmwiki-kg/ts/src/dto-stacks.test.ts
 * @description Stack and document DTOs.
 */

import { describe, expect, it } from "vitest";
import { DocumentResponse, StackCreate, StackResponse, StackUpdate } from "./dto.js";
import { TS, UUID_A, UUID_B, expectRejected, parseOk } from "./dto-harness.js";

describe("StackCreate", () => {
  const minimal = { name: "My Stack", domain: "my-stack" };

  it("applies every Python default", () => {
    expect(parseOk(StackCreate, minimal)).toEqual({
      name: "My Stack",
      domain: "my-stack",
      description: null,
      scope: "stack",
      compilation_strategy: "incremental",
      synthesize_descriptions: false,
    });
  });

  it("requires name and domain", () => {
    expectRejected(StackCreate, { domain: "ok-slug" }, "missing name");
    expectRejected(StackCreate, { name: "X" }, "missing domain");
  });

  it("enforces min_length=1 and max_length=200 on name", () => {
    expectRejected(StackCreate, { name: "", domain: "ok" }, "empty name");
    expect(parseOk(StackCreate, { name: "x".repeat(200), domain: "ok" }).name).toHaveLength(200);
    expectRejected(StackCreate, { name: "x".repeat(201), domain: "ok" }, "201-character name");
  });

  it("enforces the lowercase-hyphenated domain pattern", () => {
    // The pattern is an anchored character class, so any all-lowercase
    // digit/hyphen string passes, including leading and trailing hyphens.
    for (const domain of ["a-b-9", "trailing-", "-leading", "-"]) {
      expect(parseOk(StackCreate, { name: "X", domain }).domain, `expected ${domain} to pass`).toBe(
        domain,
      );
    }
    // All of these were confirmed as 422s on the oracle.
    for (const domain of ["NOT-A-SLUG", "with space", "under_score", "UPPER"]) {
      expectRejected(StackCreate, { name: "X", domain }, domain);
    }
  });

  it("accepts any non-empty string as name, including whitespace only", () => {
    // The oracle answers 201 for name=" "; min_length counts characters, it
    // does not strip them.
    expect(parseOk(StackCreate, { name: " ", domain: "ok4" }).name).toBe(" ");
  });

  it("strips unknown fields rather than rejecting them", () => {
    // The oracle answered 201 with a `bogus` key present.
    const parsed = parseOk(StackCreate, { ...minimal, bogus: 1 });
    expect(parsed).not.toHaveProperty("bogus");
  });

  it("accepts explicit null for the optional description", () => {
    expect(parseOk(StackCreate, { ...minimal, description: null }).description).toBeNull();
  });

  it("rejects a non-string description", () => {
    expectRejected(StackCreate, { ...minimal, description: 5 }, "numeric description");
  });
});

describe("StackUpdate", () => {
  it("makes every field optional", () => {
    expect(parseOk(StackUpdate, {})).toEqual({
      name: null,
      description: null,
      scope: null,
      compilation_strategy: null,
      synthesize_descriptions: null,
    });
  });

  it("still validates supplied values", () => {
    expectRejected(StackUpdate, { name: "" }, "empty name");
    expectRejected(StackUpdate, { name: "x".repeat(201) }, "over-long name");
    expectRejected(StackUpdate, { scope: "BAD" }, "invalid scope");
  });
});

describe("StackResponse", () => {
  const response = {
    id: UUID_A,
    name: "X",
    domain: "ok",
    description: null,
    scope: "stack",
    compilation_strategy: "incremental",
    synthesize_descriptions: false,
    created_at: TS,
    updated_at: TS,
  };

  it("parses a full response and keeps timestamps as strings", () => {
    const parsed = parseOk(StackResponse, response);
    expect(parsed.created_at).toBe(TS);
    expect(typeof parsed.created_at).toBe("string");
    // Microsecond digits survive; a Date round-trip would drop the last three.
    expect(parsed.created_at.endsWith("454886Z")).toBe(true);
  });

  it("requires description but accepts null", () => {
    const { description: _omitted, ...withoutDescription } = response;
    expectRejected(StackResponse, withoutDescription, "missing description");
    expect(parseOk(StackResponse, { ...response, description: "text" }).description).toBe("text");
  });

  it("rejects a non-UUID id", () => {
    expectRejected(StackResponse, { ...response, id: "abc" }, "invalid id");
  });
});

describe("DocumentResponse", () => {
  const response = {
    id: UUID_A,
    stack_id: UUID_B,
    filename: "doc.pdf",
    size_bytes: 1024,
    content_type: null,
    source_hash: "deadbeef",
    truncated: false,
    original_length: null,
    ingested_at: TS,
  };

  it("parses without audit, which has a Python default", () => {
    expect(parseOk(DocumentResponse, response).audit).toBeNull();
  });

  it("requires content_type and original_length but accepts null", () => {
    const { content_type: _c, ...noContentType } = response;
    expectRejected(DocumentResponse, noContentType, "missing content_type");
    const { original_length: _o, ...noOriginalLength } = response;
    expectRejected(DocumentResponse, noOriginalLength, "missing original_length");
  });

  it("rejects a float size_bytes, which Python types as int", () => {
    expectRejected(DocumentResponse, { ...response, size_bytes: 1.5 }, "float size_bytes");
    expect(parseOk(DocumentResponse, { ...response, size_bytes: 10 }).size_bytes).toBe(10);
  });
});
