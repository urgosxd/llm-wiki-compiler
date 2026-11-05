/**
 * @file packages/llmwiki-kg/ts/src/stack-id.test.ts
 * @description Pin the ONE Stack-id rule both dimensions validate against.
 *
 * The accepted set is every id the `uuid` column can hold: the canonical form is
 * the shape a client sends, and the case-insensitive and version-agnostic
 * acceptance is what keeps a well-formed id from being refused.
 *
 * The rejected set carries the three forms a permissive UUID parser WOULD accept
 * — 32 bare hex characters, the braced form, and the `urn:uuid:` prefix. These are
 * pinned deliberately: the KG side's pydantic layer is more permissive than this
 * rule, and a shared rule that quietly widened to match it would start sending
 * shapes Postgres and the wiki dimension never agreed to. Pinning them here
 * records where the boundary is, so widening it later has to be a visible change.
 */
import { describe, it, expect } from "vitest";
import { isStackId, stackIdProblem, STACK_ID_PATTERN } from "./stack-id.js";

const CANONICAL = "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8";

describe("isStackId", () => {
  it("accepts a canonical lower-case UUID", () => {
    expect(isStackId(CANONICAL)).toBe(true);
  });

  it("accepts the same UUID in upper case", () => {
    expect(isStackId(CANONICAL.toUpperCase())).toBe(true);
  });

  it("accepts the nil UUID", () => {
    expect(isStackId("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("accepts a version and variant it does not recognise", () => {
    expect(isStackId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(true);
  });

  it("rejects arbitrary text", () => {
    expect(isStackId("not-a-uuid")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isStackId("")).toBe(false);
  });

  it("rejects a UUID with a space in it", () => {
    expect(isStackId("b8b8e801 b423 4a32 ab0b e1ea2d82ead8")).toBe(false);
  });

  it("rejects the 32-bare-hex form", () => {
    expect(isStackId("b8b8e801b4234a32ab0be1ea2d82ead8")).toBe(false);
  });

  it("rejects the braced form", () => {
    expect(isStackId("{b8b8e801-b423-4a32-ab0b-e1ea2d82ead8}")).toBe(false);
  });

  it("rejects the urn:uuid form", () => {
    expect(isStackId("urn:uuid:b8b8e801-b423-4a32-ab0b-e1ea2d82ead8")).toBe(false);
  });
});

describe("stackIdProblem", () => {
  it("returns no problem for a well-formed id", () => {
    expect(stackIdProblem(CANONICAL)).toBeUndefined();
  });

  it("names the offending value and points at list_stacks", () => {
    expect(stackIdProblem("not-a-uuid")).toBe(
      "'not-a-uuid' is not a Stack id. Stack ids are UUIDs — call list_stacks to see " +
        "the ones this endpoint can reach.",
    );
  });

  it("reports the empty string with the same shape", () => {
    expect(stackIdProblem("")).toBe(
      "'' is not a Stack id. Stack ids are UUIDs — call list_stacks to see " +
        "the ones this endpoint can reach.",
    );
  });
});

describe("STACK_ID_PATTERN", () => {
  it("is exported as the canonical 8-4-4-4-12 hex form", () => {
    expect(STACK_ID_PATTERN.source).toBe(
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    );
    expect(STACK_ID_PATTERN.flags).toBe("i");
  });
});
