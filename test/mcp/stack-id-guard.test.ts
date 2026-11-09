/** Pin that a caller-named Stack that does not exist is an ERROR, not an empty list. */
import { describe, it, expect } from "vitest";
import { isUnknownStack, withTenantDatabase } from "../../packages/wiki/src/mcp/tenant-db.js";
// These two moved out of `tenant-db` into shared homes so the viewport route can use
// them without importing from `src/mcp/**`; the import here follows them.
import { stackIdProblem } from "@repo/foundation";
import { stackExists } from "../../packages/wiki/src/services/stacks/stack-store.js";

describe("stackId guard", () => {
  it("rejects a malformed id before it reaches Postgres", () => {
    expect(stackIdProblem("not-a-uuid")).toBeDefined();
    expect(stackIdProblem("")).toBeDefined();
    expect(stackIdProblem("b8b8e801-b423-4a32-ab0b-e1ea2d82ead8")).toBeUndefined();
  });

  // Preservation: the adapter moved onto the KG package's shared rule (spec S1),
  // and these two pin that the WIKI callers still get byte-identical answers. The
  // full string is asserted, not `toBeDefined()`, because every wiki surface that
  // renders this text hands it straight to a client.
  it("keeps the exact message the wiki surfaces render", () => {
    expect(stackIdProblem("not-a-uuid")).toBe(
      "'not-a-uuid' is not a Stack id. Stack ids are UUIDs — call list_stacks to see " +
        "the ones this endpoint can reach.",
    );
    expect(stackIdProblem("")).toBe(
      "'' is not a Stack id. Stack ids are UUIDs — call list_stacks to see " +
        "the ones this endpoint can reach.",
    );
  });

  it("keeps accepting a canonical id through the adapter", () => {
    expect(stackIdProblem("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(stackIdProblem("B8B8E801-B423-4A32-AB0B-E1EA2D82EAD8")).toBeUndefined();
  });

  it("reports an unknown id as unknown, not as an empty result", async () => {
    const { createDimensionsDatabase } = await import("../../packages/wiki/src/dimensions/activation.js");
    const h = createDimensionsDatabase(process.env);
    let dropFixture: (() => Promise<void>) | undefined;
    try {
      // The Stack this asserts on is created HERE: asserting that a Stack the environment
      // happened to contain still exists was the bug. See `createFixtureStack`.
      dropFixture = await createFixtureStack(h.db);
      expect(await stackExists(h.db, "00000000-0000-0000-0000-000000000000")).toBe(false);
      expect(await stackExists(h.db, "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8")).toBe(true);
    } finally {
      if (dropFixture !== undefined) await dropFixture();
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

/**
 * Create the Stack this suite asserts on, and hand back the way to drop it again.
 *
 * ## Why the fixture is created here
 *
 * The id in the assertion above names a Stack that exists in exactly one place: the
 * long-lived database a developer keeps on `:5434`. No schema file, seed or script in this
 * repository creates it, so "an id that exists is reported as existing" was proven by the
 * ENVIRONMENT rather than by the code — the same defect class as the silent skip this suite
 * family just closed — and it is red on any clean database, including CI's `services:`
 * container and the container a test run starts.
 *
 * Creating the row makes the assertion hermetic, and strictly stronger: it cannot pass by
 * accident, and it still proves both directions, because the all-zeros id asserted above is
 * one no fixture creates.
 *
 * ## Why the insert may be a no-op
 *
 * On a database that already carries this Stack (the developer's), `on conflict do nothing`
 * leaves it untouched and returns no row, so the cleanup never deletes a row this suite did
 * not create. A row this suite DID create is removed before the connection closes, so a
 * reused container cannot accumulate them.
 *
 * @param db - Handle from `createDimensionsDatabase`.
 * @returns An async cleanup; a no-op when the row already existed.
 */
async function createFixtureStack(
  db: Parameters<typeof stackExists>[0],
): Promise<() => Promise<void>> {
  const created = await db.execute<{ id: string }>(
    `insert into stacks (id, name, domain)
     values ('b8b8e801-b423-4a32-ab0b-e1ea2d82ead8', 'stack-id-guard', 'wire2')
     on conflict do nothing
     returning id`,
  );
  if (created.length === 0) return async () => undefined;
  return async () => {
    await db
      .execute(`delete from stacks where id = 'b8b8e801-b423-4a32-ab0b-e1ea2d82ead8'`)
      .catch(() => undefined);
  };
}
