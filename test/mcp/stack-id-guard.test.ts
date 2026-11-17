/**
 * @file test/mcp/stack-id-guard.test.ts
 * @description Pin that a caller-named Stack that does not exist is an ERROR, not an empty list.
 *
 * ## Why this file owns its database
 *
 * Two cases here are database-backed: they insert a Stack and assert it is found. Until
 * this file provisioned one, nothing chose WHICH database received that row — the suite
 * read whatever `AKS_DATABASE_URL` the worker inherited, which is the run's shared
 * database or a developer's long-lived server. A row in shared storage is how a suite
 * passes on leftovers from another file and how it leaves debris another file trips over.
 *
 * So the redirect happens in THIS module's scope, before `createDimensionsDatabase(process.env)`
 * below can read the value: `perRunDatabase()` mints a throwaway database, builds the
 * schema in it, and publishes its URL into the environment. What this file PROVES is
 * unchanged; where it runs is now something it owns. `stack-id-guard-isolation.test.ts`
 * pins the rule from the outside.
 *
 * ## Why a failed provision never falls back to shared state
 *
 * The rule for a database-backed suite is to FAIL when no database can be obtained, with
 * one documented exception: `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` turns that failure into a
 * skip that states its reason. Both paths go through `missingTestDatabase`, the one place
 * that words it, so this file cannot drift into a third behaviour — and the unit cases
 * below, which need no database, keep running either way.
 */
import { describe, it, expect } from "vitest";
import { isUnknownStack, withTenantDatabase } from "../../packages/wiki/src/mcp/tenant-db.js";
// These two moved out of `tenant-db` into shared homes so the viewport route can use
// them without importing from `src/mcp/**`; the import here follows them.
import { stackIdProblem } from "@repo/foundation";
import { stackExists } from "../../packages/wiki/src/services/stacks/stack-store.js";
import { ownSuiteDatabase } from "../fixtures/suite-database-ownership.js";

/** This file's path, so a "no database" failure points here and not at a fixture. */
const DATABASE_CONTEXT = "test/mcp/stack-id-guard.test.ts";

/**
 * Why the database-backed cases cannot run, or `""` when they can.
 *
 * Module scope, not a hook: `createDimensionsDatabase(process.env)` is called inside a
 * test body that may be collected before any hook runs, and `AKS_DATABASE_URL` has to
 * already name this process's database when it does.
 */
const databaseSkipReason = await ownSuiteDatabase(DATABASE_CONTEXT);

/** The database-backed cases, skipped only for the one reason above. */
const itWithDatabase = it.skipIf(databaseSkipReason !== "");

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

  itWithDatabase("reports an unknown id as unknown, not as an empty result", async () => {
    // `process.env` here already carries THIS process's database URL: the shared
    // `ownSuiteDatabase()` published it at module scope, before this body could run.
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

  itWithDatabase("returns the unknown marker from the helper a tool actually calls", async () => {
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
 * No schema file, seed or script in this repository creates this Stack, so "an id that
 * exists is reported as existing" was once proven by the ENVIRONMENT rather than by the
 * code: the row lived in the long-lived database a developer keeps on `:5434`, which made
 * the case green there and red on any clean database. Creating the row makes the assertion
 * hermetic, and still proves both directions, because the all-zeros id it is paired with is
 * one no fixture creates.
 *
 * ## Why a plain insert is enough now
 *
 * The insert targets the database this process minted (`ownSuiteDatabase()` above), so the row
 * cannot already exist and one insert is the whole fixture. It used to be `on conflict do
 * nothing`, with cleanup skipped when no row came back, because the target database was
 * shared with other suites and this one must not delete a row it did not create. That
 * branch is gone with the sharing: the delete below is hygiene inside a database that is
 * dropped wholesale when the process ends.
 *
 * @param db - Handle from `createDimensionsDatabase`.
 * @returns An async cleanup that removes the row this suite created.
 */
async function createFixtureStack(
  db: Parameters<typeof stackExists>[0],
): Promise<() => Promise<void>> {
  await db.execute(
    `insert into stacks (id, name, domain)
     values ('b8b8e801-b423-4a32-ab0b-e1ea2d82ead8', 'stack-id-guard', 'wire2')`,
  );
  return async () => {
    await db
      .execute(`delete from stacks where id = 'b8b8e801-b423-4a32-ab0b-e1ea2d82ead8'`)
      .catch(() => undefined);
  };
}
