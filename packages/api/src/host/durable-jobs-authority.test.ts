/**
 * @file packages/api/src/host/durable-jobs-authority.test.ts
 * @description Job durability is decided by the Stack authority, not by an empty id.
 *
 * WHY THIS SUITE EXISTS (spec S7b of `odd/tasks/single-stack-authority.md`). The host
 * used to read `AKS_STACK_ID` itself: empty meant "no durability", so a host with a
 * database configured and no Stack configured accepted a job into process memory and
 * lost it on exit without any error. Accepted-and-discarded is worse than a wrong
 * write, because a wrong write can be found later.
 *
 * The two legitimate answers, and the fault between them:
 *
 *   - no database configured  -> the explicit file mode: an in-memory registry and no
 *     durable reads, which is all such a deployment ever had;
 *   - database and no Stack   -> a loud, named refusal: never a registry that will
 *     discard the write;
 *   - database and a Stack    -> the durable pair, exactly as before.
 *
 * Driven at `startHost`'s own decision point rather than at startup: building a viewer
 * snapshot resolves its own authority first, so a startup-level assertion would report
 * the seam's refusal and never reach job durability at all.
 */
import { describe, expect, it } from "vitest";
import { durableJobReadsFor, durableRegistryFor } from "./server.js";

/** The two variables whose combination this suite varies. */
const STACK_ENV_VAR = "AKS_STACK_ID";
const DATABASE_ENV_VAR = "AKS_DATABASE_URL";

/**
 * A DSN naming no reachable server.
 *
 * Durability has to be decided BEFORE a connection is opened, so this value proves the
 * decision is not a probe: a refusal here is about configuration, not reachability. It
 * carries no credentials, and constructing a client does not connect.
 */
const UNREACHABLE_DSN = "postgres://nobody@127.0.0.1:1/unreachable";

/** A well-formed Stack id, so nothing below can read as a malformed-id complaint. */
const SOME_STACK_ID = "0b6d1f2e-3c4a-4b5c-8d9e-0f1a2b3c4d5e";

describe("job durability follows the resolved Stack authority", () => {
  it("refuses a registry when a database is configured and no Stack resolves", () => {
    // THE RED OF S7b: to-day this returns a plain in-memory registry, so every job the
    // host accepts is discarded on exit and no caller is told.
    const env = { [DATABASE_ENV_VAR]: UNREACHABLE_DSN };
    expect(() => durableRegistryFor(env)).toThrow(/must have a Stack/);
    expect(() => durableRegistryFor(env)).toThrow(new RegExp(STACK_ENV_VAR));
  });

  it("refuses the durable reads when a database is configured and no Stack resolves", () => {
    // `undefined` here is the same defect one level down: the viewer treats it as
    // "memory only" and answers from a registry that dies with the process.
    const env = { [DATABASE_ENV_VAR]: UNREACHABLE_DSN };
    expect(() => durableJobReadsFor(env)).toThrow(/must have a Stack/);
  });

  it("keeps the explicit file mode when no database is configured", () => {
    // S2: no database at all is a supported deployment, and a loud failure above must
    // not delete it. The observable outcome is what is pinned, not the branch.
    expect(durableRegistryFor({}).list()).toEqual([]);
    expect(durableJobReadsFor({})).toBeUndefined();
  });

  it("keeps the durable pair when a database is configured and a Stack is named", () => {
    // The preserve pin: the refusal must be about a MISSING Stack, never about having
    // a database. Both entries still answer, and the reads still expose a per-Stack view.
    const env = { [DATABASE_ENV_VAR]: UNREACHABLE_DSN, [STACK_ENV_VAR]: SOME_STACK_ID };
    expect(durableRegistryFor(env).list()).toEqual([]);
    const reads = durableJobReadsFor(env);
    expect(typeof reads?.list).toBe("function");
    expect(typeof reads?.get).toBe("function");
    expect(typeof reads?.forStack).toBe("function");
  });
});
