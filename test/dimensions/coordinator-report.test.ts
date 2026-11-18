/**
 * @file test/dimensions/coordinator-report.test.ts
 * @description What the coordinator RECORDS about each dimension on one run, and
 * the order it runs them in.
 *
 * ## Why this file does not use the Postgres harness
 *
 * The sibling `coordinator.test.ts` drives a real database because it measures
 * atomicity, and a stubbed handle could not prove "both or neither". THIS file
 * measures a different claim: which per-dimension facts the coordinator retains for
 * the report, and in what order it calls the dimensions. A handle that opens a
 * transaction without a server answers that honestly, keeps the suite in the unit
 * tier, and is the reason the ordering case can run in an ordinary editing turn.
 *
 * The doubles are the same shape the sibling file uses -- one object per dimension
 * with a `name` and the lifecycle methods -- so a behavioural difference between
 * the two files is never an artefact of a different fixture.
 *
 * ## The ordering case is the one that matters most
 *
 * `wiki` before `kg` used to fall out of the incoming array, which arrives in
 * `KNOWN_DIMENSIONS` order from `resolveDimensions`. That is an accident of one
 * caller, not a guarantee. The reversed-array case below is what separates the two:
 * it passes `kg` first and asserts the coordinator still prepared and committed
 * `wiki` first (S14).
 */
import { describe, expect, it } from "vitest";

import {
  IngestDimensionFailure,
  ingestDimensions,
} from "../../packages/wiki/src/dimensions/coordinator.js";
import type {
  CommittedWrite,
  Dimension,
  DimensionInput,
  DimensionName,
  PreparedWrite,
} from "../../packages/wiki/src/dimensions/types.js";
import type { DatabaseHandle } from "@repo/foundation";

/** Input shared by every case. */
const INPUT: DimensionInput = {
  source: "https://example.test/a",
  title: "A",
  document: "# A\n\nbody\n",
  body: "body",
};

/** A Stack id the coordinator only ever binds on a transaction it never opens. */
const STACK_ID = "11111111-1111-1111-1111-111111111111";

/**
 * A handle whose transaction runs its body and touches nothing.
 *
 * The coordinator's only use of the handle is `db.transaction(callback)` with a
 * tenant bind inside it, so this double keeps every call the run makes observable
 * while opening no connection. Cast through `unknown` because the real handle is a
 * drizzle client and this is deliberately not one.
 *
 * @returns A handle that opens a transaction and does nothing else.
 */
function handleWithoutServer(): DatabaseHandle {
  return {
    transaction: async (body: (tx: { execute: () => Promise<never[]> }) => Promise<unknown>) =>
      body({ execute: async () => [] }),
  } as unknown as DatabaseHandle;
}

/** How one double should misbehave, when it should. */
interface Misbehaviour {
  /** Return no handle at all, which is how a dimension says it has nothing to do. */
  readonly prepareReturnsNothing?: boolean;
  /** Throw this exact error from `commit`, so `cause` identity is assertable. */
  readonly commitError?: Error;
}

/**
 * A dimension double that records every call it receives, in order.
 *
 * @param name - Which dimension this is.
 * @param calls - Log receiving one `<name>:<phase>` entry per call.
 * @param misbehaviour - Optional failure or decline for the case under test.
 * @returns The double.
 */
function recordingDimension(
  name: DimensionName,
  calls: string[],
  misbehaviour: Misbehaviour = {},
): Dimension {
  return {
    name,
    async prepare(): Promise<PreparedWrite> {
      calls.push(`${name}:prepare`);
      if (misbehaviour.prepareReturnsNothing === true) return null as unknown as PreparedWrite;
      return { unchanged: false, handle: { name } };
    },
    async commit(): Promise<CommittedWrite> {
      calls.push(`${name}:commit`);
      if (misbehaviour.commitError !== undefined) throw misbehaviour.commitError;
      return { idempotencyKey: `${name}:key`, summary: `${name}:ok` };
    },
    async discard(): Promise<void> {},
    // Removal is a separate lifecycle step from the write (see the port), and the
    // coordinator under test never calls it. Present so the double satisfies
    // `Dimension` rather than so any case here can exercise it.
    async forget(): Promise<void> {},
  };
}

/**
 * Run an ingest and hand back the failure it threw.
 *
 * @param dimensions - Dimensions to run, in the caller's order.
 * @returns The thrown value, unexamined, so a case can assert what it actually is.
 */
async function failureOf(dimensions: readonly Dimension[]): Promise<unknown> {
  try {
    await ingestDimensions(handleWithoutServer(), STACK_ID, INPUT, dimensions);
  } catch (error) {
    return error;
  }
  throw new Error("the ingest was expected to fail and did not");
}

describe("what the coordinator records for a run that commits", () => {
  it("records both committed runs and keeps the summaries map unchanged", async () => {
    const calls: string[] = [];
    const outcome = await ingestDimensions(handleWithoutServer(), STACK_ID, INPUT, [
      recordingDimension("wiki", calls),
      recordingDimension("kg", calls),
    ]);

    expect(outcome.dimensionRuns).toEqual([
      { name: "wiki", state: "committed", summary: "wiki:ok" },
      { name: "kg", state: "committed", summary: "kg:ok" },
    ]);
    // S2: `summaries` is not replaced by the richer record, it sits beside it.
    expect([...outcome.summaries.entries()]).toEqual([
      ["wiki", "wiki:ok"],
      ["kg", "kg:ok"],
    ]);
  });

  it("records a dimension that prepared nothing as declined", async () => {
    const calls: string[] = [];
    const outcome = await ingestDimensions(handleWithoutServer(), STACK_ID, INPUT, [
      recordingDimension("wiki", calls),
      recordingDimension("kg", calls, { prepareReturnsNothing: true }),
    ]);

    expect(outcome.dimensionRuns[1]).toEqual({ name: "kg", state: "declined" });
    expect(outcome.summaries.has("kg")).toBe(false);
  });
});

describe("what the coordinator records for a run that fails", () => {
  it("throws IngestDimensionFailure naming the run that failed, its message and cause", async () => {
    const collect: string[] = [];
    const graphError = new Error("kg commit failed");
    const caught = await failureOf([
      recordingDimension("wiki", collect),
      recordingDimension("kg", collect, { commitError: graphError }),
    ]);

    expect(caught).toBeInstanceOf(IngestDimensionFailure);
    const failure = caught as IngestDimensionFailure;
    // The message and the cause are what existed BEFORE this change, so both are
    // pinned: a caller that logs the message and a caller that inspects the cause
    // must keep working.
    expect(failure.message).toBe("ingest failed after 2 attempts: kg commit failed (unresolved: wiki)");
    expect(failure.cause).toBe(graphError);
  });

  it("marks only the throwing dimension failed on that same failure", async () => {
    const collect: string[] = [];
    const caught = await failureOf([
      recordingDimension("wiki", collect),
      recordingDimension("kg", collect, { commitError: new Error("kg commit failed") }),
    ]);

    const runs = (caught as IngestDimensionFailure).dimensionRuns;
    expect(runs.find((run) => run.name === "kg")).toEqual({
      name: "kg",
      state: "failed",
      error: "kg commit failed",
    });
    // The rolled-back dimension must not be blamed: it did not throw, and reporting
    // it as failed would send an operator to the wrong component.
    expect(runs.find((run) => run.name === "wiki")?.state).not.toBe("failed");
  });
});

describe("the order the coordinator runs dimensions in", () => {
  it("prepares and commits wiki before kg even when the caller reverses them", async () => {
    const calls: string[] = [];
    const outcome = await ingestDimensions(handleWithoutServer(), STACK_ID, INPUT, [
      recordingDimension("kg", calls),
      recordingDimension("wiki", calls),
    ]);

    expect(calls).toEqual(["wiki:prepare", "kg:prepare", "wiki:commit", "kg:commit"]);
    expect(outcome.dimensionRuns.map((run) => run.name)).toEqual(["wiki", "kg"]);
  });

  it("runs a single dimension whatever position the caller passes it in", async () => {
    const calls: string[] = [];
    const outcome = await ingestDimensions(handleWithoutServer(), STACK_ID, INPUT, [
      recordingDimension("kg", calls),
    ]);

    expect(calls).toEqual(["kg:prepare", "kg:commit"]);
    expect(outcome.dimensionRuns).toEqual([{ name: "kg", state: "committed", summary: "kg:ok" }]);
  });
});
