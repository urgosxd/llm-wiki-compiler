/**
 * @file packages/api/src/host/durable-jobs-authority.test.ts
 * @description Job durability follows the Stack the JOB names, not a process variable.
 *
 * WHY THIS SUITE EXISTS (spec S7b of `odd/tasks/single-stack-authority.md`). The host used to
 * read `AKS_STACK_ID` itself: empty meant "no durability", so a host with a database configured
 * and no Stack resolved accepted a job into process memory and lost it on exit without any error.
 * Accepted-and-discarded is worse than a wrong write, because a wrong write can be found later.
 *
 * WHAT CHANGED, AND WHY THE FIRST PIN IS REVERSED ON PURPOSE
 *
 * The answer used to be "refuse to BUILD the pair": `durableRegistryFor` threw when a database was
 * configured and nothing resolved. That was right while the boot provisioned a Stack, and it
 * became the defect S6 of `odd/tasks/stack-authority-per-request.md` had to remove — a host with
 * an empty `public.stacks` refused to listen, and a host that does not listen cannot receive the
 * `POST /stacks` that creates the first Stack. The refusal moved from construction to the JOB,
 * where the Stack now arrives:
 *
 *   - no database configured   -> the explicit file mode: an in-memory registry, no durable reads;
 *   - database, no bound Stack -> a registry that REFUSES a job naming no Stack, and mirrors a job
 *                                 that names one under THAT Stack; reads keep the per-Stack view
 *                                 and refuse the host's own stack-agnostic view;
 *   - database, bound Stack    -> the durable pair, exactly as before.
 *
 * Driven at `startHost`'s own decision point rather than at startup: building a viewer snapshot
 * resolves its own answer first, so a startup-level assertion would report that seam and never
 * reach job durability at all.
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

/** A database configured, and no Stack bound by the process: S6's fresh-deployment shape. */
const UNBOUND_ENV = { [DATABASE_ENV_VAR]: UNREACHABLE_DSN };

describe("job durability follows the Stack the job names", () => {
  it("builds a registry on a database with no bound Stack, instead of refusing to build one", () => {
    // THE REVERSAL: to-day this threw, and that throw is what stopped the host from binding.
    // A host with an empty `public.stacks` must listen so `POST /stacks` can reach it.
    expect(durableRegistryFor(UNBOUND_ENV).list()).toEqual([]);
  });

  it("refuses, by name, a job that names no Stack, and stores nothing", () => {
    const registry = durableRegistryFor(UNBOUND_ENV);
    expect(() => registry.create("notes/a.md", new Date())).toThrow(/must have a Stack/);
    // The remedy, not only the situation: an operator has to be able to act on the message.
    expect(() => registry.create("notes/a.md", new Date())).toThrow(new RegExp(STACK_ENV_VAR));
    // Rejected input leaves the registry exactly as it was: nothing accepted, nothing to lose.
    expect(registry.list()).toEqual([]);
  });

  it("serves a job that names a Stack, so a named request is never refused", () => {
    // The other half of the same rule: the refusal is about a job with NO Stack, never about
    // having no bound one. A request that names its Stack is attributable and must run.
    const registry = durableRegistryFor(UNBOUND_ENV);
    const job = registry.create("notes/a.md", new Date(), SOME_STACK_ID);
    expect(registry.get(job.id)?.id).toBe(job.id);
    expect(registry.list().map((retained) => retained.id)).toContain(job.id);
  });

  it("refuses the host's own job view while the per-Stack view stays open", async () => {
    // `list`/`get` mean "every job THIS HOST has". A host that bound no Stack has no such set:
    // this process's memory view mixes every Stack a request named, so answering it would hand
    // one Stack's job to a request that named another. `forStack` reads the rows of the Stack
    // the caller named, which is the per-request answer.
    const reads = durableJobReadsFor(UNBOUND_ENV);
    await expect(reads?.list(10)).rejects.toThrow(/must have a Stack/);
    await expect(reads?.get("ing_missing")).rejects.toThrow(new RegExp(STACK_ENV_VAR));
    expect(typeof reads?.forStack).toBe("function");
  });

  it("keeps the explicit file mode when no database is configured", () => {
    // S2 of the earlier feature: no database at all is a supported deployment, and a loud
    // failure above must not delete it. The observable outcome is what is pinned, not the branch.
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
