/**
 * @file packages/foundation/src/dimensions-port.test.ts
 * @description The `DimensionsPort` seam refuses to be absent: a caller that needs
 * the configured dimensions and received no port gets a named error, never an empty
 * dimension set.
 *
 * WHY THIS FILE EXISTS. The seam's whole value is the refusal. A port that resolves
 * nothing when it is missing would let compile and ingest run with zero dimensions,
 * write nothing, and report success — the silent-empty-set failure the mechanism
 * exists to prevent. Nothing else checks that: the type says `DimensionsPort |
 * undefined`, so the compiler is satisfied by a caller that passes `undefined` and
 * never looks at the answer.
 *
 * WHY IT LIVES HERE. `@repo/foundation` is the bottom layer, so this package may not
 * import a dimension to build a real one. The port is structural — an object with a
 * `resolve` method — so a stand-in written in three lines proves everything this
 * file needs to claim, and the proof stays on the allowed edge of the topology.
 *
 * The empty-request case is here because it is the same failure wearing a different
 * input: a caller whose configured dimensions were lost before they reached the
 * refusal would otherwise be told "no dimensions enabled", which reads like a
 * working configuration.
 */
import { describe, expect, it } from "vitest";
import { MissingDimensionsPortError, requireDimensionsPort } from "./dimensions-port.js";
import type { DimensionsPort } from "./dimensions-port.js";

/** A port that resolves the names it was built with; enough to prove identity. */
const STAND_IN_PORT: DimensionsPort<string> = { resolve: () => ["wiki"] };

/**
 * Run `call` and return the error it threw.
 *
 * @param call - The call expected to refuse.
 * @returns The thrown error, already asserted to be an `Error`.
 */
function thrownBy(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the call to throw, but it returned");
}

describe("requireDimensionsPort", () => {
  it("returns the very port it was given", () => {
    expect(requireDimensionsPort(STAND_IN_PORT, ["wiki"])).toBe(STAND_IN_PORT);
  });

  it("throws a named error when no port was supplied", () => {
    const error = thrownBy(() => requireDimensionsPort(undefined, ["kg"]));

    expect(error).toBeInstanceOf(MissingDimensionsPortError);
    expect(error.name).toBe("MissingDimensionsPortError");
  });

  it("names every requested dimension in the refusal", () => {
    const single = thrownBy(() => requireDimensionsPort(undefined, ["kg"])).message;
    expect(single).toContain(
      'LLMWIKI_DIMENSIONS enables "kg" but no DimensionsPort was supplied to resolve it.',
    );

    const both = thrownBy(() => requireDimensionsPort(undefined, ["wiki", "kg"])).message;
    expect(both).toContain('"wiki"');
    expect(both).toContain('"kg"');
    expect(both).toContain("no DimensionsPort was supplied");
  });

  it("refuses an empty request instead of resolving nothing", () => {
    // A port IS supplied here: the refusal is about the request, so a caller that
    // lost its configured dimensions cannot pass a working port and get a silent
    // empty answer.
    const error = thrownBy(() => requireDimensionsPort(STAND_IN_PORT, []));

    expect(error).toBeInstanceOf(MissingDimensionsPortError);
    expect(error.name).toBe("MissingDimensionsPortError");
  });
});
