/**
 * @file test/host/ingest-stack-concurrency.test.ts
 * @description Two ingests naming different Stacks must not cross.
 *
 * ## What this pins, and why the previous approach could not
 *
 * The Stack used to be applied by assigning into `process.env` and restoring it after.
 * That is correct exactly while no two writers overlap, so the property was defended by
 * locks rather than by the code. This suite asserts the property directly: build the two
 * environments at the same time and prove each still names its own Stack.
 *
 * A test that ran the two sequentially would pass under the mutation — that is the trap
 * this file exists to avoid. The environments are computed and INSPECTED concurrently,
 * before either is used, because that is the only arrangement in which a shared mutable
 * env shows up as a failure.
 */
import { describe, it, expect } from "vitest";
import { buildIngestEnv } from "../../src/host/ingest-env.js";

const STACK_A = "11111111-1111-4111-8111-111111111111";
const STACK_B = "22222222-2222-4222-8222-222222222222";

describe("per-request ingest environment", () => {
  it("keeps two concurrent requests on their own Stack", async () => {
    const [envA, envB] = await Promise.all([
      Promise.resolve().then(() => buildIngestEnv(STACK_A)),
      Promise.resolve().then(() => buildIngestEnv(STACK_B)),
    ]);

    expect(envA.AKS_STACK_ID).toBe(STACK_A);
    expect(envB.AKS_STACK_ID).toBe(STACK_B);
    // Neither may have touched the process, or a third concurrent caller would
    // inherit whichever finished last.
    expect(process.env.AKS_STACK_ID).not.toBe(STACK_A);
    expect(process.env.AKS_STACK_ID).not.toBe(STACK_B);
  });

  it("omits the named Stack from the process when none was given", () => {
    const env = buildIngestEnv(undefined);
    // The bound environment passes through unchanged, which is what keeps a
    // single-Stack deployment on the old behaviour.
    expect(env).toBe(process.env);
  });
});
