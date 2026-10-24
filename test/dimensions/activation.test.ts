/**
 * @file test/dimensions/activation.test.ts
 * @description The environment switch that decides which dimensions run.
 *
 * Postgres is required for BOTH dimensions since the file-backed wiki was
 * retired, so every case here supplies a Stack id and a database handle. The
 * cases that assert a REFUSAL are the load-bearing ones: a caller that forgot
 * either must be told, not handed a dimension bound to some other backend.
 *
 * The switch's default still matters: an unset variable must enable `wiki` and
 * nothing else, so the enabled SET is unchanged even though what backs it now is.
 */

import { describe, it, expect } from "vitest";
import { createDatabase, createClient, type Database } from "llmwiki-kg";
import {
  AKS_STACK_ID_ENV_VAR,
  DIMENSIONS_ENV_VAR,
  DimensionActivationError,
  resolveDimensions,
} from "../../src/dimensions/activation.js";

/**
 * A database handle that is never connected to.
 *
 * Resolution only BUILDS dimensions; it opens no connection, so a lazy client
 * proves the wiring without requiring a live Postgres for the pure switch cases.
 */
function lazyDatabase(): Database {
  return createDatabase(createClient("postgresql://unused:unused@localhost:1/unused", 1));
}

/** Resolve with a synthetic environment and a usable handle. */
function resolve(env: NodeJS.ProcessEnv, db: Database = lazyDatabase()) {
  return resolveDimensions({ root: "/tmp/project", env, kgDryRun: true, db });
}

describe("resolveDimensions", () => {
  it("enables only wiki when the switch is absent", () => {
    const dimensions = resolve({ [AKS_STACK_ID_ENV_VAR]: "stack-1" });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki"]);
  });

  it("treats an empty switch as the default", () => {
    const dimensions = resolve({
      [DIMENSIONS_ENV_VAR]: "   ",
      [AKS_STACK_ID_ENV_VAR]: "stack-1",
    });

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
      [AKS_STACK_ID_ENV_VAR]: "stack-1",
    });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki"]);
  });

  it("rejects an unknown dimension", () => {
    expect(() =>
      resolve({ [DIMENSIONS_ENV_VAR]: "wiki,graph", [AKS_STACK_ID_ENV_VAR]: "stack-1" }),
    ).toThrow(DimensionActivationError);
  });

  it("rejects kg without a stack id", () => {
    expect(() => resolve({ [DIMENSIONS_ENV_VAR]: "wiki,kg" })).toThrow(/AKS_STACK_ID/);
  });

  /* The wiki dimension is Postgres-only now, so a missing Stack id must refuse
   * BEFORE any dimension is built -- a wiki with no tenant has nothing to key a
   * page row by, and defaulting one would silently mix projects together. */
  it("rejects wiki without a stack id", () => {
    expect(() => resolve({})).toThrow(/AKS_STACK_ID/);
  });

  /* There is no test for "wiki without a database handle" because that case is
   * now unrepresentable: `db` is a REQUIRED field, so a caller that omits it
   * fails to compile rather than failing at runtime. Asserting it here would
   * need a cast that defeats the type, which would test the cast and not the
   * contract. The compile error is the guarantee. */

  it("accepts kg with a stack id", () => {
    const dimensions = resolve({
      [DIMENSIONS_ENV_VAR]: "wiki,kg",
      [AKS_STACK_ID_ENV_VAR]: "stack-1",
    });

    expect(dimensions.map((d) => d.name)).toEqual(["wiki", "kg"]);
  });
});
