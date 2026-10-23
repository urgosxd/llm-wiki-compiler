/**
 * @file test/dimensions/activation.test.ts
 * @description The environment switch that decides which dimensions run.
 *
 * The default matters more than any single case: an unset switch must produce
 * exactly the pre-feature behaviour, so these tests pin that first.
 */

import { describe, it, expect } from "vitest";
import {
  AKS_STACK_ID_ENV_VAR,
  DIMENSIONS_ENV_VAR,
  DimensionActivationError,
  resolveDimensions,
} from "../../src/dimensions/activation.js";

/** Resolve with a synthetic environment. */
function resolve(env: NodeJS.ProcessEnv) {
  return resolveDimensions({ root: "/tmp/project", env, kgDryRun: true });
}

describe("resolveDimensions", () => {
  it("enables only wiki when the switch is absent", () => {
    const dimensions = resolve({});

    expect(dimensions.map((d) => d.name)).toEqual(["wiki"]);
  });

  it("treats an empty switch as the default", () => {
    const dimensions = resolve({ [DIMENSIONS_ENV_VAR]: "   " });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki"]);
  });

  it("enables both dimensions in commit order", () => {
    const dimensions = resolve({
      [DIMENSIONS_ENV_VAR]: "kg,wiki",
      [AKS_STACK_ID_ENV_VAR]: "stack-1",
    });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki", "kg"]);
  });

  it("deduplicates repeated names", () => {
    const dimensions = resolve({
      [DIMENSIONS_ENV_VAR]: "wiki,wiki",
    });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki"]);
  });

  it("rejects an unknown dimension", () => {
    expect(() => resolve({ [DIMENSIONS_ENV_VAR]: "wiki,graph" })).toThrow(
      DimensionActivationError,
    );
  });

  it("rejects kg without a stack id", () => {
    expect(() => resolve({ [DIMENSIONS_ENV_VAR]: "wiki,kg" })).toThrow(
      /AKS_STACK_ID/,
    );
  });

  it("accepts kg with a stack id", () => {
    const dimensions = resolve({
      [DIMENSIONS_ENV_VAR]: "wiki,kg",
      [AKS_STACK_ID_ENV_VAR]: "stack-1",
    });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki", "kg"]);
  });
});
