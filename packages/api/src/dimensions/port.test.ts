/**
 * @file packages/api/src/dimensions/port.test.ts
 * @description The first real `DimensionsPort` implementation, exercised rather
 * than inspected: the refusal a caller without a port receives, and the delegation
 * a caller with one gets.
 *
 * WHY THIS FILE EXISTS. The seam in `@repo/foundation` has, until now, been an
 * interface with zero consumers — an interface nobody has tested against reality.
 * Two things here can only be proven by running them: that a caller who did not
 * receive a port is refused loudly (spec L18.S7), and that this implementation's
 * `resolve` reaches wiki's own resolution machinery instead of re-deriving it.
 *
 * WHY IT LIVES IN `@repo/api`. This package is the only one permitted to join the
 * two dimensions, so it is the only place the real implementation may exist. The
 * delegation is NOT mocked: mocking `@repo/wiki/dimensions-activation` would make
 * the one claim worth testing — that the port is a thin, honest forwarder — untestable.
 *
 * NO DATABASE IS OPENED. Every dimension here is constructed, never queried:
 * `createWikiStoreDimension` builds an object literal over the handle it is given,
 * and the postgres-js pool connects lazily, so the handle below can reject every
 * statement and still prove the wiring.
 */
import { describe, expect, it } from "vitest";
import { MissingDimensionsPortError, requireDimensionsPort } from "@repo/foundation";
import type { DatabaseHandle, DimensionsPort, DimensionsRequest } from "@repo/foundation";
import { DimensionActivationError, resolveDimensions } from "@repo/wiki/dimensions-activation";
import type { CreateWikiOptions } from "@repo/wiki/compiler-sdk";
import { createDimensionsPort } from "./port.js";

/**
 * The published option accepts the port this factory returns.
 *
 * The direction that ships: an embedder hands `createDimensionsPort()`'s result to
 * `CreateWikiOptions.dimensionsPort`, and the published shape is the one the wiki
 * ingest path declares authoritative (`packages/wiki/src/services/ingest/service.ts`).
 * Type-level on purpose — a drift here is a `tsc` failure, not a runtime expectation.
 *
 * Asserted HERE, beside the factory, rather than from `test/`: `eslint.config.mjs`'s
 * `WIKI_TO_API` boundary forbids a root-side test from naming this package in any
 * form, and this guard must not be the reason to weaken that rule.
 */
const _acceptedByPublishedOptions: NonNullable<CreateWikiOptions["dimensionsPort"]> =
  createDimensionsPort();
void _acceptedByPublishedOptions;

/** wiki's own dimension type, reached through the resolver rather than by name. */
type WikiDimension = ReturnType<typeof resolveDimensions>[number];

/** A Stack the caller resolved itself, so no environment variable decides it. */
const RESOLVED_STACK_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/**
 * A handle that fails if anything asks it a question.
 *
 * Constructing a dimension must not query — that is the seam's contract, and this
 * stub turns a violation into a loud test failure instead of a connection attempt.
 */
const UNQUERIED_DB: DatabaseHandle = {
  execute: () => Promise.reject(new Error("resolution must not execute a statement")),
  transaction: () => Promise.reject(new Error("resolution must not open a transaction")),
};

/**
 * Build a request the way a production caller states one.
 *
 * @param overrides - The fields this case varies.
 * @returns The request, with one environment and one handle.
 */
function request(overrides: Partial<DimensionsRequest> = {}): DimensionsRequest {
  return {
    only: ["wiki"],
    env: { LLMWIKI_DIMENSIONS: "wiki,kg", AKS_STACK_ID: RESOLVED_STACK_ID },
    root: "/tmp/dimensions-port-project",
    db: UNQUERIED_DB,
    stackId: RESOLVED_STACK_ID,
    ...overrides,
  };
}

describe("createDimensionsPort", () => {
  it("returns a port that satisfies foundation's interface", () => {
    // The assignment IS the proof: a port whose `resolve` did not match
    // `DimensionsPort<Dimension>` would not compile in a type-checked test file.
    const port: DimensionsPort<WikiDimension> = createDimensionsPort();

    expect(typeof port.resolve).toBe("function");
  });

  it("resolves only the dimensions both the request and the environment allow", () => {
    const dimensions = createDimensionsPort().resolve(request({ only: ["wiki"] }));

    // The switch enables `wiki,kg` and the request narrows to `wiki`: the port must
    // forward the narrowing, so the graph dimension is never constructed.
    expect(dimensions.map((dimension) => dimension.name)).toEqual(["wiki"]);
  });

  it("never enables a dimension the environment disabled", () => {
    const dimensions = createDimensionsPort().resolve(
      request({ only: ["wiki", "kg"], env: { LLMWIKI_DIMENSIONS: "wiki" } }),
    );

    expect(dimensions.map((dimension) => dimension.name)).toEqual(["wiki"]);
  });

  it("refuses a dimension name this build cannot write", () => {
    // `only` is `readonly string[]` at the seam, so an unknown name is a real input
    // and not a type error. Silently dropping it would resolve a subset and report
    // success — the silent-zero failure the whole seam exists to refuse.
    expect(() => createDimensionsPort().resolve(request({ only: ["nope"] }))).toThrow(
      DimensionActivationError,
    );
    expect(() => createDimensionsPort().resolve(request({ only: ["nope"] }))).toThrow(
      'Unknown dimension "nope"',
    );
  });

  it("refuses a caller that received no port", () => {
    // Spec L18.S7, executed: the failure to refuse is the one that ships, so this
    // asserts the thrown INSTANCE and the message a reader will actually see.
    expect(() => requireDimensionsPort(undefined, ["wiki"])).toThrow(MissingDimensionsPortError);
    expect(() => requireDimensionsPort(undefined, ["wiki"])).toThrow(
      'LLMWIKI_DIMENSIONS enables "wiki" but no DimensionsPort was supplied to resolve it.',
    );
  });

  it("requires every request to state its narrowing", () => {
    // `only` is REQUIRED at the seam, and this file is type-checked by
    // `typecheck:tests`: making it optional again would leave this directive unused
    // and fail the gate, which is what makes the requirement durable.
    // @ts-expect-error - `only` is required: a resolution states which dimensions it may return.
    const incomplete: DimensionsRequest = { env: {}, root: "/tmp/dimensions-port-project", db: UNQUERIED_DB };

    expect(incomplete.root).toBe("/tmp/dimensions-port-project");
  });
});
