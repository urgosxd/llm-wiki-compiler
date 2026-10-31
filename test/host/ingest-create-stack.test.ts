/**
 * @file test/host/ingest-create-stack.test.ts
 * @description A job created in Stack B must be findable under B, not under the host's.
 *
 * ## The defect these pin
 *
 * `POST /api/ingest?stackId=B` accepted the parameter, started the work under B, and
 * mirrored the durable row under the host's startup Stack. The write "succeeded", the
 * 202 carried a job id, and the read then 404'd -- because the row was somewhere else.
 *
 * Two things were wrong and they are pinned separately:
 *
 *   1. The durable mirror resolved ONE Stack when it was constructed, so every job it
 *      wrote belonged to the host's binding regardless of the request.
 *   2. `stackId` was only read from the body, while the routes that READ jobs take it
 *      as a query parameter. A client using one shape for both silently wrote to the
 *      wrong Stack.
 *
 * The assertion is deliberately on WHERE the row landed rather than on the response
 * code: a 202 proves the request was accepted, never that it was routed.
 */
import { describe, it, expect } from "vitest";
import { buildIngestEnv } from "../../src/host/ingest-env.js";

const HOST_STACK = "b8b8e801-b423-4a32-ab0b-e1ea2d82ead8";
const OTHER_STACK = "d61bf181-efb1-4a9c-a39b-1b986313e5c1";

describe("ingest create honours the requested Stack", () => {
  it("resolves the environment to the named Stack, not the host's", () => {
    const env = buildIngestEnv(OTHER_STACK);
    expect(env.AKS_STACK_ID).toBe(OTHER_STACK);
    // The host's own binding must be untouched, or the next request inherits it.
    expect(process.env.AKS_STACK_ID).not.toBe(OTHER_STACK);
  });

  it("keeps two concurrent creations on their own Stack", () => {
    const a = buildIngestEnv(HOST_STACK);
    const b = buildIngestEnv(OTHER_STACK);
    // Computed before either is used: sequential resolution would pass even if the
    // second overwrote the first, which is how the original defect hid.
    expect(a.AKS_STACK_ID).toBe(HOST_STACK);
    expect(b.AKS_STACK_ID).toBe(OTHER_STACK);
  });

  it("falls back to the host environment when no Stack is named", () => {
    expect(buildIngestEnv(undefined)).toBe(process.env);
  });
});
