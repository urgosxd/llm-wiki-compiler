/**
 * @file test/dimensions/stack-selection.test.ts
 * @description Which Stack a command works on, and where that choice came from.
 *
 * These cases are pure: selection reads an argument and an environment, never a
 * database, so a wrong precedence is reported as a wrong value rather than as a
 * connection error. The one database-shaped case at the end proves the OTHER half
 * of the contract — that a caller who already resolved a Stack can hand it over and
 * be answered without the environment being consulted at all.
 */

import { describe, it, expect } from "vitest";
import { createDatabase, createClient, type Database } from "llmwiki-kg";
import {
  AKS_STACK_ID_ENV_VAR,
  DIMENSIONS_ENV_VAR,
  resolveDimensions,
} from "../../src/dimensions/activation.js";
import {
  DEFAULT_STACK_DOMAIN,
  DEFAULT_STACK_NAME,
  describeStackSelection,
  selectStack,
} from "../../src/dimensions/stack-selection.js";

const FLAG_STACK = "11111111-1111-1111-1111-111111111111";
const ENV_STACK = "33333333-3333-3333-3333-333333333333";
const SUPPLIED_STACK = "22222222-2222-2222-2222-222222222222";

/**
 * A handle that is never connected to.
 *
 * Resolution only BUILDS dimensions, so a lazy client proves the wiring without a
 * live Postgres — the same device `activation.test.ts` uses.
 */
function lazyDatabase(): Database {
  return createDatabase(createClient("postgresql://unused:unused@localhost:1/unused", 1));
}

describe("selectStack", () => {
  it("prefers the flag over the environment", () => {
    const selection = selectStack({ flag: FLAG_STACK, env: { [AKS_STACK_ID_ENV_VAR]: ENV_STACK } });

    expect(selection).toEqual({ kind: "explicit", source: "flag", stackId: FLAG_STACK });
  });

  it("uses AKS_STACK_ID when no flag was given", () => {
    const selection = selectStack({ env: { [AKS_STACK_ID_ENV_VAR]: ENV_STACK } });

    expect(selection).toEqual({ kind: "explicit", source: "env", stackId: ENV_STACK });
  });

  it("falls back to the default Stack when nothing is configured", () => {
    const selection = selectStack({ env: {} });

    expect(selection).toEqual({ kind: "default", source: "default", domain: DEFAULT_STACK_DOMAIN });
  });

  it("treats blank values as absent", () => {
    const selection = selectStack({ flag: "   ", env: { [AKS_STACK_ID_ENV_VAR]: "  " } });

    expect(selection).toEqual({ kind: "default", source: "default", domain: DEFAULT_STACK_DOMAIN });
  });

  it("trims the value it selects", () => {
    const selection = selectStack({ flag: `  ${FLAG_STACK}  `, env: {} });

    expect(selection).toEqual({ kind: "explicit", source: "flag", stackId: FLAG_STACK });
  });

  it("does not throw when nothing is configured", () => {
    expect(() => selectStack({ env: {} })).not.toThrow();
    expect(() => selectStack()).not.toThrow();
  });
});

describe("describeStackSelection", () => {
  it("names the flag as the origin", () => {
    const text = describeStackSelection(selectStack({ flag: FLAG_STACK, env: {} }));

    expect(text).toBe(`Stack ${FLAG_STACK} (from --stack)`);
  });

  it("names the environment variable as the origin", () => {
    const text = describeStackSelection(selectStack({ env: { [AKS_STACK_ID_ENV_VAR]: ENV_STACK } }));

    expect(text).toBe(`Stack ${ENV_STACK} (from ${AKS_STACK_ID_ENV_VAR})`);
  });

  it("names the default as the origin", () => {
    const text = describeStackSelection(selectStack({ env: {} }));

    expect(text).toBe(`Stack ${DEFAULT_STACK_DOMAIN} (from the default Stack)`);
  });

  it("keeps the fixed default identity stable", () => {
    expect(DEFAULT_STACK_DOMAIN).toBe("default");
    expect(DEFAULT_STACK_NAME).toBe("Default");
  });
});

describe("resolveDimensions with a supplied Stack", () => {
  /* The caller resolved a Stack, so the environment must not be consulted: an
   * empty environment here would otherwise raise the "AKS_STACK_ID is not set"
   * refusal this change exists to make unreachable. */
  it("builds the wiki dimension without reading AKS_STACK_ID", () => {
    const dimensions = resolveDimensions({
      root: "/tmp/project",
      env: { [DIMENSIONS_ENV_VAR]: "wiki" },
      db: lazyDatabase(),
      stackId: SUPPLIED_STACK,
    });

    expect(dimensions.map((dimension) => dimension.name)).toEqual(["wiki"]);
  });

  it("builds both dimensions from the supplied Stack", () => {
    const dimensions = resolveDimensions({
      root: "/tmp/project",
      env: { [DIMENSIONS_ENV_VAR]: "wiki,kg" },
      db: lazyDatabase(),
      stackId: SUPPLIED_STACK,
      kgDryRun: true,
    });

    expect(dimensions.map((dimension) => dimension.name)).toEqual(["wiki", "kg"]);
  });

  it("falls back to the environment when the supplied Stack is blank", () => {
    const dimensions = resolveDimensions({
      root: "/tmp/project",
      env: { [DIMENSIONS_ENV_VAR]: "wiki", [AKS_STACK_ID_ENV_VAR]: ENV_STACK },
      db: lazyDatabase(),
      stackId: "   ",
    });

    expect(dimensions.map((dimension) => dimension.name)).toEqual(["wiki"]);
  });
});
