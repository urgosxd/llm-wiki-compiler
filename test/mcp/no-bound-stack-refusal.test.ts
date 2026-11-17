/**
 * @file test/mcp/no-bound-stack-refusal.test.ts
 * @description A deployment with no Stack bound still refuses — it never guesses one.
 *
 * ## What changed, and what did not
 *
 * Every Stack-scoped tool takes a REQUIRED `stackId`, so "which tenant am I answering
 * about" is no longer a question the environment can answer: the old substitution inside
 * `withTenantDatabase` is gone. What survives is the EXEMPTION — `list_stacks` may still
 * be called with no argument, because a discovery tool cannot demand the identifier of the
 * thing it discovers. What does NOT survive is resolving that omission from the deployment
 * binding: `boundStackOrProblem` used to read `AKS_STACK_ID` and report that Stack as the
 * current one, which is ambient resolution wearing a tool's clothes. It refuses by name
 * instead (`unnamedArgumentProblem`), and the refusal below is measured against an
 * UNREACHABLE DSN so "it did not open a connection to find a Stack" is observable and not
 * merely asserted.
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
import {
  isRefusal,
  unnamedArgumentProblem,
  withTenantDatabase,
} from "../../packages/wiki/src/mcp/tenant-db.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";

/**
 * The wording this module used to answer with, kept ONLY to prove it is gone.
 *
 * It instructs the reader to set `AKS_STACK_ID`, which is the behaviour S5 removes — so on
 * a database-configured run it may not come back, and the case below names it to be sure.
 */
const RETIRED_ENV_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

/** A DSN on a closed port: reaching the database at all would fail loudly. */
const UNREACHABLE_DSN = "postgresql://nobody:nobody@127.0.0.1:1/absent";

/** A well-formed id, so nothing below is refused for being malformed. */
const A_STACK_ID = "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8";

const env = createEnvSnapshot(["AKS_STACK_ID", "AKS_DATABASE_URL"]);

afterEach(() => env.restore());

describe("withTenantDatabase on a deployment with no Stack bound", () => {
  it("refuses the exempt discovery tool's omission by name, resolving nothing", () => {
    env.setEnv({ AKS_DATABASE_URL: UNREACHABLE_DSN });

    const outcome = unnamedArgumentProblem(process.env);

    // Deep equality on the marker shape, then the wording by its two load-bearing parts:
    // the situation (a database is configured) and the omission that caused it.
    expect(isRefusal(outcome)).toBe(true);
    const { unavailable } = outcome as { unavailable: string };
    expect(unavailable).toContain("AKS_DATABASE_URL is configured");
    expect(unavailable).toContain("list_stacks was called with no stackId");
    // And the instruction to bind the environment is what this change ends.
    expect(unavailable).not.toBe(RETIRED_ENV_MESSAGE);
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
