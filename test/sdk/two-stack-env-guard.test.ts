/**
 * @file test/sdk/two-stack-env-guard.test.ts
 * @description The shared two-Stack opening REFUSES a void proof: with no database, a
 * suite fails instead of passing on nothing.
 *
 * ## Why the guard itself is pinned
 *
 * Every Stack-versus-ambient proof in this directory opens through
 * `test/sdk/two-stack-env.ts`, whose `requireReachable` asserts reachability with an
 * explicit message. That assertion is the only thing standing between a broken database
 * and a green cross-tenant suite: without it a worker with no database reaches the
 * assertions, finds nothing to compare, and reports the door closed while measuring
 * nothing at all — the false green the harness exists to prevent.
 *
 * Observing that refusal once, in a run that happened to have no database, is not
 * evidence that it survives: a later edit that turns the assertion into a tolerant
 * `return` would keep every suite green and quietly void every proof. So the refusal is
 * pinned here, at its own boundary, with a pair that reached nothing.
 *
 * The stub is deliberately minimal: `requireReachable` reads one field (`reachable`) and
 * the two openings that call it read nothing else before they throw, so the rest of the
 * harness shape is cast rather than fabricated. No database, no provider, no Stack is
 * touched by this file.
 */
import { expect, it } from "vitest";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import {
  handleOnAmbientStack,
  handleOnBoundStack,
  requireReachable,
  type TwoStacks,
} from "./two-stack-env.js";

/** The refusal a void proof must raise, matched from its first character. */
const VOID_PROOF = /^no database reached this worker: the cross-tenant proof is void\b/;

/** A Stack reporting that nothing reached it — `reachable` is the only field the guard reads. */
function unreachedStack(): ProbeStack {
  return {
    harness: { reachable: false } as unknown as KgPostgresHarness,
    env: () => ({}) as NodeJS.ProcessEnv,
  };
}

/** The pair a worker holds when no database reached it. */
function voidProof(): TwoStacks {
  return {
    ambient: unreachedStack(),
    bound: unreachedStack(),
    root: "/nonexistent-void-proof-root",
    release: async () => {},
  };
}

it("refuses a proof that no database reached, naming why it is void", () => {
  expect(() => requireReachable(voidProof())).toThrow(VOID_PROOF);
});

it("hands no handle to a suite body when no database reached this worker", async () => {
  await expect(handleOnBoundStack(voidProof())).rejects.toThrow(VOID_PROOF);
  expect(() => handleOnAmbientStack(voidProof())).toThrow(VOID_PROOF);
});
