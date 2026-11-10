/**
 * @file packages/wiki/src/dimensions/enabled-dimension-names.test.ts
 * @description ONE reader of the dimension switch, and the proof that the Stack
 * pre-check is not a second one.
 *
 * ## The defect this pins
 *
 * `LLMWIKI_DIMENSIONS` was parsed textually twice: authoritatively in
 * `activation.ts` (which refuses an unknown name) and again as a "mirror"
 * pre-check in `services/stacks/resolve-stack.ts` (which tolerated one). A second
 * reader is a second answer to one question, and the two answers had already
 * drifted: the mirror reported "no dimension enabled" for
 * `LLMWIKI_DIMENSIONS=nope`, so `compile` skipped graph retirement in silence
 * where the resolver refuses the very same environment a line later.
 *
 * ## Why the assertions are behavioural
 *
 * The rule is "the same environment cannot produce two answers", so every case
 * below drives the REAL entry points — the exported reader, `resolveDimensions`,
 * and `resolveStackForDimensions` — and compares what an operator would see. The
 * one structural case exists because a behaviour test cannot see a tolerated
 * duplicate that happens to answer correctly today; it reads the source and
 * asserts the variable is not named there at all.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DatabaseHandle } from "@repo/foundation";
import { describe, expect, it } from "vitest";

import { resolveStackForDimensions } from "../services/stacks/resolve-stack.js";
import {
  DimensionActivationError,
  enabledDimensionNames,
  resolveDimensions,
} from "./activation.js";
import type { DimensionName } from "./types.js";

/** The refusal the authority produces, asserted verbatim at every entry point. */
const UNKNOWN_NAME_REFUSAL =
  'Unknown dimension "nope" in LLMWIKI_DIMENSIONS. Known dimensions: wiki, kg.';

/** The source whose textual copy of the switch this change removes. */
const RESOLVE_STACK_SOURCE = fileURLToPath(
  new URL("../services/stacks/resolve-stack.ts", import.meta.url),
);

/** A project root, which resolution reads no file from on these paths. */
const ROOT = "/tmp/enabled-dimension-names";

/**
 * Every switch value a caller can present, with the names it must resolve to.
 *
 * Case 4 is the one a naive `split(",")` gets wrong (whitespace and order), case 5
 * the one it gets wrong by answering twice (a duplicate is one dimension).
 */
const RESOLVED_CASES: ReadonlyArray<readonly [string, string | undefined, DimensionName[]]> = [
  ["unset", undefined, ["wiki"]],
  ["empty", "", ["wiki"]],
  ["separators only", " , ", ["wiki"]],
  ["single name", "wiki", ["wiki"]],
  ["both, in order", "wiki,kg", ["wiki", "kg"]],
  ["whitespace and reversed order", " kg , wiki ", ["kg", "wiki"]],
  ["a duplicate", "wiki,wiki", ["wiki"]],
];

/**
 * A handle that fails on the FIRST property access.
 *
 * Used where the case must prove a refusal happens BEFORE any database work: a
 * query, a transaction or even an accidental `await` of the handle names itself
 * in the failure instead of producing a misleading "no Stack" answer.
 *
 * @returns A handle no path under test may use.
 */
function probeDb(): DatabaseHandle {
  return new Proxy({} as object, {
    get(_target, property) {
      throw new Error(`resolution reached the database (asked for "${String(property)}")`);
    },
  }) as DatabaseHandle;
}

/**
 * The refusal message `run` throws, or a failure when it returns normally.
 *
 * @param run - The entry point to drive.
 * @returns The message of the {@link DimensionActivationError} it threw.
 */
function refusalFrom(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DimensionActivationError) return error.message;
    throw error;
  }
  throw new Error("the call returned normally instead of refusing an unknown dimension name");
}

describe("enabledDimensionNames", () => {
  it.each(RESOLVED_CASES)("resolves %s", (_label, raw, expected) => {
    const env: NodeJS.ProcessEnv =
      raw === undefined ? {} : { LLMWIKI_DIMENSIONS: raw };
    expect(enabledDimensionNames(env)).toEqual(expected);
  });

  it("reads process.env when no environment is supplied", () => {
    const previous = process.env.LLMWIKI_DIMENSIONS;
    process.env.LLMWIKI_DIMENSIONS = "wiki,kg";
    try {
      expect(enabledDimensionNames()).toEqual(["wiki", "kg"]);
    } finally {
      if (previous === undefined) delete process.env.LLMWIKI_DIMENSIONS;
      else process.env.LLMWIKI_DIMENSIONS = previous;
    }
  });
});

describe("an unknown dimension name", () => {
  const env: NodeJS.ProcessEnv = { LLMWIKI_DIMENSIONS: "nope" };

  it("is refused in the same words by the reader, the resolver, and the Stack pre-check", async () => {
    const fromReader = refusalFrom(() => enabledDimensionNames(env));
    const fromResolver = refusalFrom(() => resolveDimensions({ root: ROOT, db: probeDb(), env }));

    // The pre-check answers before any Stack is resolved, so an unknown name has to
    // be refused HERE too, in the authority's own words, instead of being answered
    // as "no dimension enabled" -- which is what let a misconfigured compile skip
    // graph retirement in silence.
    const fromPreCheck = await resolveStackForDimensions(probeDb(), env, ["kg"]).then(
      (answer) => {
        throw new Error(
          `the Stack pre-check answered ${answer === undefined ? "no Stack needed" : answer} ` +
            `for an unknown dimension name instead of refusing it`,
        );
      },
      (error: unknown) => error,
    );
    expect(fromPreCheck).toBeInstanceOf(DimensionActivationError);

    expect(fromReader).toBe(UNKNOWN_NAME_REFUSAL);
    expect(fromResolver).toBe(UNKNOWN_NAME_REFUSAL);
    expect((fromPreCheck as Error).message).toBe(UNKNOWN_NAME_REFUSAL);
  });
});

describe("the Stack pre-check still answers what it answered before", () => {
  it("needs no Stack for a wiki-only switch, and touches no database", async () => {
    // A bare checkout: `wiki` alone is enabled, so nothing the retirement path asks
    // for is on, and provisioning the default Stack would open a connection for a
    // dimension nobody uses.
    expect(await resolveStackForDimensions(probeDb(), {}, ["kg"])).toBeUndefined();
  });

  it("uses a configured Stack as given, whatever the switch says", async () => {
    expect(
      await resolveStackForDimensions(
        probeDb(),
        { AKS_STACK_ID: "11111111-1111-4111-8111-111111111111" },
        ["kg"],
      ),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("the switch has exactly one reader inside the package", () => {
  it("is not named in the Stack resolver's source at all", () => {
    const source = readFileSync(RESOLVE_STACK_SOURCE, "utf8");

    // A tolerated copy answers correctly for every case above and still drifts on
    // the next change, so the guarantee has to be structural: the resolver reaches
    // the switch through the authority or not at all.
    expect(source).not.toContain("LLMWIKI_DIMENSIONS");
    expect(source).not.toContain("DIMENSIONS_ENV_VAR");
  });
});
