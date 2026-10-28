/** Pin that a caller-named Stack that does not exist is an ERROR, not an empty list. */
import { describe, it, expect } from "vitest";
import { isUnknownStack, withTenantDatabase } from "../../src/mcp/tenant-db.js";
// These two moved out of `tenant-db` into shared homes so the viewport route can use
// them without importing from `src/mcp/**`; the import here follows them.
import { stackIdProblem } from "../../src/utils/stack-id.js";
import { stackExists } from "../../src/services/stacks/stack-store.js";

describe("stackId guard", () => {
  it("rejects a malformed id before it reaches Postgres", () => {
    expect(stackIdProblem("not-a-uuid")).toBeDefined();
    expect(stackIdProblem("")).toBeDefined();
    expect(stackIdProblem("b8b8e801-b423-4a32-ab0b-e1ea2d82ead8")).toBeUndefined();
  });

  it("reports an unknown id as unknown, not as an empty result", async () => {
    const { createDimensionsDatabase } = await import("../../src/dimensions/activation.js");
    const h = createDimensionsDatabase(process.env);
    try {
      expect(await stackExists(h.db, "00000000-0000-0000-0000-000000000000")).toBe(false);
      expect(await stackExists(h.db, "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8")).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("returns the unknown marker from the helper a tool actually calls", async () => {
    // Exercises the DECISION, not just the query it depends on. Asserting on
    // `stackExists` alone leaves the guard removable: it was removed during a
    // mutation check and this suite still passed.
    const result = await withTenantDatabase(
      async () => "reached-the-database",
      "00000000-0000-0000-0000-000000000000",
    );
    expect(isUnknownStack(result)).toBe(true);
  });

  it("returns a clear error for a malformed id instead of querying", async () => {
    const result = await withTenantDatabase(async () => "reached-the-database", "not-a-uuid");
    expect(isUnknownStack(result)).toBe(false);
    expect(result).toHaveProperty("unavailable");
  });

  it("recognises the unknown-stack marker so callers can branch on it", () => {
    expect(isUnknownStack({ unknownStack: "x" })).toBe(true);
    expect(isUnknownStack({ unavailable: "x" })).toBe(false);
  });
});
