/**
 * @file test/mcp/no-bound-stack-refusal.test.ts
 * @description A deployment with no Stack bound still refuses — it never guesses one.
 *
 * ## What changed, and what did not
 *
 * Every Stack-scoped tool now takes a REQUIRED `stackId`, so "which tenant am I
 * answering about" is no longer a question the environment can answer: the old
 * substitution inside `withTenantDatabase` is gone. What survives is the EXEMPTION.
 * `list_stacks` may still be called with no argument — a discovery tool cannot demand
 * the identifier of the thing it discovers — and there the deployment binding is the
 * only thing that can name the Stack whose entry is marked current. That resolution is
 * `boundStackOrProblem`, and it must refuse rather than guess when nothing is bound.
 *
 * ## Why an unreachable DSN is part of the fixture
 *
 * "Must not reach the database" is not observable from the return value alone: a path
 * that opened a connection and then found no Stack could return the same marker. So the
 * environment points `AKS_DATABASE_URL` at a port nothing listens on. A single query —
 * including one that would provision a default Stack — fails against it, and that
 * failure surfaces here instead of the marker.
 */
import { describe, it, expect, afterEach } from "vitest";
import { boundStackOrProblem, isRefusal, withTenantDatabase } from "../../packages/wiki/src/mcp/tenant-db.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";

/** What the exempt discovery tool reports on an unbound deployment, verbatim. */
const NO_STACK_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

/** A DSN on a closed port: reaching the database at all would fail loudly. */
const UNREACHABLE_DSN = "postgresql://nobody:nobody@127.0.0.1:1/absent";

/** A well-formed id, so nothing below is refused for being malformed. */
const A_STACK_ID = "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8";

const env = createEnvSnapshot(["AKS_STACK_ID", "AKS_DATABASE_URL"]);

afterEach(() => env.restore());

describe("withTenantDatabase on a deployment with no Stack bound", () => {
  it("hands the exempt discovery tool the unbound-deployment marker", () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });

    const outcome = boundStackOrProblem(process.env);

    // Deep equality, not a substring: the marker shape and the wording are both part
    // of what a client sees, and this test exists to freeze both.
    expect(outcome).toEqual({ unavailable: NO_STACK_MESSAGE });
    expect(isRefusal(outcome)).toBe(true);
  });

  it("refuses instead of answering from the environment when the database is down", async () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });
    let ran = false;

    // The Stack can only come from the argument now, so an unbound deployment has
    // nothing to offer — and an unreachable database must not look like a valid Stack.
    await expect(
      withTenantDatabase(async () => {
        ran = true;
        return "the tool ran";
      }, A_STACK_ID),
    ).rejects.toThrow();

    // Load-bearing: refusing AND running the work would tell a caller "cannot answer"
    // while the query it asked for already happened.
    expect(ran).toBe(false);
  });

  it("does not write a Stack into the environment as a side effect", async () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });

    await withTenantDatabase(async () => "the tool ran", A_STACK_ID).catch(() => undefined);

    expect(process.env.AKS_STACK_ID).toBeUndefined();
  });
});
