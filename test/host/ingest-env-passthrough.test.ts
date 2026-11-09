/**
 * @file test/host/ingest-env-passthrough.test.ts
 * @description The per-request ingest environment copies for a named Stack and
 * hands back the process environment untouched when none is named.
 *
 * ## What this pins, and why it is a PRESERVE test
 *
 * Two deployments share `buildIngestEnv`. A host serving one Stack names no Stack
 * per request and must keep reading `process.env` exactly as it always has, while
 * a host serving several hands each request its own copy. The defaulting work
 * (S1) changes what happens when NOTHING is configured, and it must not change
 * either of these two: a single-Stack deployment that suddenly received a copy, or
 * a copy that leaked back into the process, would break isolation in the direction
 * nobody asked for.
 *
 * Nothing here is expected to be red first — the behaviour predates the change and
 * this file freezes it.
 *
 * ## Why the environment is snapshotted
 *
 * The developer's own shell may export `AKS_STACK_ID`. Leaving it in place would
 * make "no Stack was injected" vacuously true on a machine that already had one and
 * false in CI, so every case clears it first and restores it afterwards.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildIngestEnv } from "../../packages/wiki/src/host/ingest-env.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";

/** An id shaped like a real Stack, so nothing can be confused with a default. */
const NAMED_STACK = "9d1f4e2a-6b31-4c8f-9a52-1f0a6d3c7b84";

const env = createEnvSnapshot(["AKS_STACK_ID"]);

afterEach(() => env.restore());

describe("buildIngestEnv with no Stack named", () => {
  it("returns the process environment itself, with no Stack written into it", () => {
    env.setEnv({});

    const resolved = buildIngestEnv(undefined);

    // Identity, not equality: a copy would be a different object with the same
    // values, and a caller mutating it would then mean something else than it did.
    expect(resolved).toBe(process.env);
    expect(resolved.AKS_STACK_ID).toBeUndefined();
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(process.env).sort());
  });
});

describe("buildIngestEnv with a Stack named", () => {
  it("sets the variable on a copy and leaves the process environment alone", () => {
    env.setEnv({});

    const resolved = buildIngestEnv(NAMED_STACK);

    expect(resolved).not.toBe(process.env);
    expect(resolved.AKS_STACK_ID).toBe(NAMED_STACK);
    // The bound environment is what every other caller in this process still reads,
    // so a write here would send their documents to this request's Stack.
    expect(process.env.AKS_STACK_ID).toBeUndefined();
  });

  it("carries the rest of the environment into the copy", () => {
    env.setEnv({});

    const resolved = buildIngestEnv(NAMED_STACK);

    // Replacing the environment instead of extending it would drop the database
    // credentials and provider keys the pipelines need, which reads downstream as
    // "nothing is configured" rather than as a bug here.
    expect(resolved.PATH).toBe(process.env.PATH);
  });
});
