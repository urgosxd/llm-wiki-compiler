/**
 * @file test/mcp/no-bound-stack-refusal.test.ts
 * @description An unbound MCP deployment still refuses, and never borrows the
 * CLI's default Stack.
 *
 * ## What this pins, and why it is a PRESERVE test
 *
 * Giving the CLI a default Stack (S1) must not reach the MCP deployment binding
 * (S7): that path serves a Stack an operator named at deploy time, so defaulting
 * there would silently retarget a running server at a Stack nobody chose.
 *
 * Nothing here is expected to be red first. The refusal at
 * `src/mcp/tenant-db.ts` predates the defaulting work and the change was not
 * supposed to alter it, so this file exists to notice the day it does — not to
 * drive a fix.
 *
 * ## Why an unreachable DSN is part of the fixture
 *
 * "Must not reach the database" is not observable from the return value alone: a
 * path that opened a connection and then found no Stack could return the same
 * marker. So the environment points `AKS_DATABASE_URL` at a port nothing listens
 * on. A single query — including the one that would provision a default Stack —
 * fails against it, and the failure would surface here as a rejection instead of
 * the marker. The refusal has to happen before any connection exists.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isRefusal, withTenantDatabase } from "../../src/mcp/tenant-db.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";

/** What every Stack-scoped tool says on an unbound deployment, verbatim. */
const NO_STACK_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

/** A DSN on a closed port: reaching the database at all would fail loudly. */
const UNREACHABLE_DSN = "postgresql://nobody:nobody@127.0.0.1:1/absent";

const env = createEnvSnapshot(["AKS_STACK_ID", "AKS_DATABASE_URL"]);

afterEach(() => env.restore());

describe("withTenantDatabase on a deployment with no Stack bound", () => {
  it("hands back the unbound-deployment marker, with the message unchanged", async () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });

    const outcome = await withTenantDatabase(async () => "the tool ran");

    // Deep equality, not a substring: the marker shape and the wording are both
    // part of what a client sees, and this test exists to freeze both.
    expect(outcome).toEqual({ unavailable: NO_STACK_MESSAGE });
    expect(isRefusal(outcome)).toBe(true);
  });

  it("refuses instead of running the tool", async () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });
    let ranWith: string | undefined;

    await withTenantDatabase(async (_db, stackId) => {
      ranWith = stackId;
      return "the tool ran";
    });

    // Load-bearing: refusing AND running the work would leave a caller told "cannot
    // answer" while the query it asked for already happened.
    expect(ranWith).toBeUndefined();
  });

  it("does not invent a Stack and does not write one into the environment", async () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });

    const outcome = await withTenantDatabase(async () => "the tool ran");

    // Not the "no such Stack" refusal: nothing was named, so nothing may be checked
    // and nothing may be substituted.
    expect(outcome).not.toHaveProperty("unknownStack");
    expect(process.env.AKS_STACK_ID).toBeUndefined();
  });
});
