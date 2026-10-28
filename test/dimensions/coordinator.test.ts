/**
 * @file test/dimensions/coordinator.test.ts
 * @description Behaviour of the transactional coordinator under failure.
 *
 * These cases drive in-memory doubles, so every failure ordering is deterministic.
 * The shipped wiki and graph dimensions are measured against real tables in
 * `ingest-atomicity.test.ts`.
 *
 * ## What "nothing was written" can mean for a double
 *
 * A double never touches the database, so the honest observations here are the
 * coordinator's own calls -- how many times it asked, in what order, and what it
 * reported. The row-level claim (both dimensions commit or neither does) is not
 * provable from this file and is not attempted here; the suite that owns it drives
 * real dimensions against real tables.
 *
 * A Postgres handle is still required: the coordinator opens a real transaction and
 * binds the tenant on it, so a suite that stubbed the handle would not be testing
 * the thing that provides atomicity.
 *
 * ## The failure line replaced the failed row
 *
 * A rolled-back ingest used to leave a `failed` outbox row. The outbox is gone, so
 * the same facts go to stderr as one JSON object per line, and that line is now the
 * only diagnostic a failed ingest produces -- which is why the cases below assert
 * its exact fields rather than merely that something was logged.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";

import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import type {
  CommittedWrite,
  Dimension,
  DimensionInput,
  DimensionName,
  PreparedWrite,
} from "../../src/dimensions/types.js";

/** Input shared by every case. */
const INPUT: DimensionInput = {
  source: "https://example.test/a",
  title: "A",
  document: "# A\n\nbody\n",
  body: "body",
};

/**
 * A dimension double whose phases are individually controllable.
 *
 * It counts ATTEMPTS for `prepare` and `commit`, not just successes, because the
 * retry contract is about how many times the coordinator asks -- two attempts of the
 * transaction and exactly one `prepare`. A double that only counted successes could
 * not tell a retried commit from a single one.
 */
function makeDimension(
  name: DimensionName,
  behaviour: {
    prepareFails?: boolean;
    commitFails?: boolean;
    discardFails?: boolean;
  } = {},
): Dimension & {
  discarded: number;
  committed: number;
  prepareAttempts: number;
  commitAttempts: number;
} {
  const state = { discarded: 0, committed: 0, prepareAttempts: 0, commitAttempts: 0 };
  return {
    name,
    // Getters must live on the returned object. Spreading a getter-bearing literal
    // EVALUATES it once at spread time, which copies the initial zero and makes
    // every later read answer 0 forever -- measured, and the reason three
    // assertions above started reporting 0 for work the double clearly did.
    get discarded() {
      return state.discarded;
    },
    get committed() {
      return state.committed;
    },
    get prepareAttempts() {
      return state.prepareAttempts;
    },
    get commitAttempts() {
      return state.commitAttempts;
    },
    async prepare(): Promise<PreparedWrite> {
      state.prepareAttempts += 1;
      if (behaviour.prepareFails === true) throw new Error(`${name} prepare failed`);
      return { unchanged: false, handle: { name } };
    },
    async commit(): Promise<CommittedWrite> {
      state.commitAttempts += 1;
      if (behaviour.commitFails === true) throw new Error(`${name} commit failed`);
      state.committed += 1;
      return { idempotencyKey: `${name}:key`, summary: `${name}:ok` };
    },
    async discard(): Promise<void> {
      if (behaviour.discardFails === true) throw new Error(`${name} discard failed`);
      state.discarded += 1;
    },
  };
}

/**
 * The usual pair: a healthy wiki and a graph with the behaviour under test.
 *
 * Extracted because four cases build exactly this pair and only the graph's failure
 * mode differs; four copies were flagged as a clone group, and a copy is where a
 * case quietly stops exercising what its name says.
 *
 * @param kgBehaviour - How the graph dimension should misbehave.
 * @returns The wiki double first, the graph double second.
 */
function wikiAndKg(
  kgBehaviour: Parameters<typeof makeDimension>[1] = {},
): [ReturnType<typeof makeDimension>, ReturnType<typeof makeDimension>] {
  return [makeDimension("wiki"), makeDimension("kg", kgBehaviour)];
}

/**
 * Capture what the coordinator writes to stderr for the duration of `body`.
 *
 * `process.stderr.write` is the only seam the failure path has: the line is
 * deliberately buffered nowhere a caller can read it, because an operator is its
 * reader. The spy is restored in a `finally` so a failing assertion cannot leave
 * stderr hijacked for the next case.
 *
 * @param body - Assertions to run while stderr is captured.
 * @returns The lines written, one entry per `write` call.
 */
async function captureStderr(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await body();
    return lines;
  } finally {
    spy.mockRestore();
  }
}

/** The parsed failure line, or a clear failure when none was written. */
function failureLineOf(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

/**
 * Run an ingest that is expected to fail, and capture the diagnosis it logged.
 *
 * Three cases need the same three steps -- build the failing pair, assert the
 * rejection, capture stderr -- and writing them out each time is what
 * `fallow` flagged as duplication. The `expected` argument is the message each
 * case is actually about, so the helper stays honest about WHAT failed.
 *
 * @param expected - The rejection message this case is asserting.
 * @returns The lines written to stderr while the ingest ran.
 */
async function ingestFailureLines(expected: RegExp | string): Promise<string[]> {
  const [wiki, kg] = wikiAndKg({ commitFails: true });
  return captureStderr(async () => {
    await expect(
      ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg]),
    ).rejects.toThrow(expected);
  });
}

const harness = await createKgPostgresHarness("coordinator");

afterAll(async () => {
  await harness.cleanup();
});

describe.skipIf(!harness.reachable)("ingestDimensions", () => {
  it("commits both dimensions and reports both summaries", async () => {
    const [wiki, kg] = wikiAndKg();

    const outcome = await ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg]);

    expect(outcome.summaries.get("wiki")).toBe("wiki:ok");
    expect(outcome.summaries.get("kg")).toBe("kg:ok");
    expect(outcome.artifactPath).toBeUndefined();
    expect(wiki.committed).toBe(1);
    expect(kg.committed).toBe(1);
  });

  it("commits nothing and logs nothing when prepare fails", async () => {
    const wiki = makeDimension("wiki");
    const kg = makeDimension("kg", { prepareFails: true });

    // A `prepare` failure happens BEFORE the transaction opens, so the caller's own
    // error is the diagnostic. A second line here would be a lie about a rollback
    // that never happened.
    const lines = await captureStderr(async () => {
      await expect(
        ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg]),
      ).rejects.toThrow("kg prepare failed");
    });

    expect(wiki.committed).toBe(0);
    expect(kg.committed).toBe(0);
    expect(lines).toEqual([]);
  });

  /*
   * THE CENTRAL GUARANTEE, and it replaces a case that asserted a `failed` row.
   *
   * The old expectation was a `failed` outbox record written after the rollback.
   * That row is gone with the table; the same facts are one structured line on
   * stderr, and nothing landed.
   */
  it("rolls BOTH dimensions back when one fails, leaving no recovery debt", async () => {
    const lines = await ingestFailureLines(/ingest failed after 2 attempts/);

    // The doubles run OUTSIDE the transaction, so their counters record that the
    // coordinator ASKED twice -- the retry contract -- and that the failing
    // dimension never reported success. The wiki's counter is NOT asserted: its
    // commit returns normally both times because the transaction it was handed is
    // the real database's, and what escaped the rollback is not something a double
    // can see. The `unresolved` case below covers the guard that stops the
    // coordinator trusting a commit whose transaction it rolled back.
    expect(failureLineOf(lines)["outcome"]).toBe("failed");
  });

  it("retries the transaction exactly twice, reusing the prepared handles", async () => {
    // Two attempts of the TRANSACTION, not of the run: `prepare` is where the
    // provider calls live, so a retry that re-prepared would pay twice.
    const [wiki, kg] = wikiAndKg({ commitFails: true });

    await expect(ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg])).rejects.toThrow();

    expect(wiki.commitAttempts).toBe(2);
    expect(wiki.prepareAttempts).toBe(1);
  });

  it("names the dimension a failed discard could not clean up", async () => {
    const wiki = makeDimension("wiki", { discardFails: true });
    const kg = makeDimension("kg", { commitFails: true });

    await expect(
      ingestDimensions(harness.db, harness.stackId, INPUT, [wiki, kg]),
    ).rejects.toThrow(/unresolved: wiki/);
  });

  it("reports the source, dimensions, attempts and error on the failure line", async () => {
    const lines = await ingestFailureLines(/ingest failed after 2 attempts/);

    const line = failureLineOf(lines);
    // `event` is what a log query selects on; `outcome` and `error` are what a
    // human reading one line needs.
    expect(line["event"]).toBe("ingest_failed");
    expect(line["outcome"]).toBe("failed");
    expect(line["source"]).toBe(INPUT.source);
    expect(line["dimensions"]).toEqual(["wiki", "kg"]);
    expect(line["attempts"]).toBe(2);
    expect(line["error"]).toBe("kg commit failed");
  });
});
