/**
 * @file test/compiler/default-dimensions-port-narrowing.test.ts
 * @description The default dimensions port REFUSES an unknown name in `only`, instead
 * of narrowing it away and resolving nothing.
 *
 * ## Why this is pinned at the port and not only at the switch
 *
 * `DimensionsRequest.only` is `readonly string[]` at the seam, so an unknown name is a
 * real input rather than a type error. The default port composes the compiler's
 * resolution, and a port that FILTERED unknown names would answer "resolved, empty
 * set" — the silent-zero shape this whole seam exists to refuse, reintroduced one
 * layer up: graph retirement would vanish with a success, which is exactly the bug the
 * switch already refuses.
 *
 * The handle below throws on any access, so the case also pins the ORDER: narrowing
 * refuses before resolution reads anything.
 */

import { describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@repo/foundation";
import {
  DimensionActivationError,
  createDefaultDimensionsPort,
} from "../../packages/wiki/src/dimensions/activation.js";

/** The refusal, asserted as a prefix: the authority owns the sentence around it. */
const UNKNOWN_NAME_REFUSAL = 'Unknown dimension "nope"';

/**
 * A handle that throws the moment anything is asked of it.
 *
 * @returns A handle no resolution path may use.
 */
function unreachableHandle(): DatabaseHandle {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property): never {
      throw new Error(
        `the port reached its database handle for "${String(property)}" before narrowing`,
      );
    },
  }) as unknown as DatabaseHandle;
}

describe("the default dimensions port", () => {
  it("refuses an unknown name rather than resolving an empty set", () => {
    const port = createDefaultDimensionsPort();
    const request = { root: "/nonexistent", db: unreachableHandle(), env: {}, only: ["nope"] };

    expect(() => port.resolve(request)).toThrow(DimensionActivationError);
    expect(() => port.resolve(request)).toThrow(UNKNOWN_NAME_REFUSAL);
  });

  it("resolves the same request when the name is one this build can write", () => {
    // Identical call, known name: it gets past narrowing and resolves the graph, so
    // the case above proves a REFUSAL rather than a port that never works.
    const port = createDefaultDimensionsPort();
    const env: NodeJS.ProcessEnv = { LLMWIKI_DIMENSIONS: "kg", AKS_STACK_ID: "stack-1" };

    const resolved = port.resolve({
      root: "/nonexistent",
      db: unreachableHandle(),
      env,
      only: ["kg"],
    });

    expect(resolved.map((dimension) => dimension.name)).toEqual(["kg"]);
  });
});
