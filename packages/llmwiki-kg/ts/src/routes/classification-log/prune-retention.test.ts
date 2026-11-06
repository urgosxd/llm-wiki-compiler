/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/prune-retention.test.ts
 * @description The promises a failure prune makes about everything it does NOT delete:
 * the rest of the graph stays byte-identical, the per-occurrence signal inside the
 * window survives, and two concurrent prunes of one Stack cannot delete a row twice.
 *
 * WHY THIS FILE EXISTS. Deleting stored rows is the most dangerous thing this package
 * does, and the two ways it can go wrong are both silent. It can reach too far — a
 * rollup, a cascade, a mistaken table — and leave a Stack whose classifications,
 * evidence or edges are not the ones that were there a moment ago. Or it can reach
 * twice under concurrency, and a double delete of a real event is indistinguishable
 * from an event that never happened.
 *
 * So the three tests below assert the NEGATIVE space of the operation rather than its
 * count: the whole protected graph is compared before and after as full row text, a
 * candidate that failed 47 times inside the window still reads as exactly 47
 * consecutive failures after the older tail is gone, and two simultaneous confirm runs
 * together delete each eligible row exactly once while losing none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  delete process.env["TYPESAFE_API_KEY"];
});

import { createTransactionRunner } from "../../db.js";
import {
  createStack,
  database,
  deleteFixtureRows,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { FAILURE_REASON_PREFIX, pruneClassificationFailures } from "./prune.js";
import {
  logRows,
  MINUTES_PER_DAY,
  seedGraphFixture,
  seedLogRows,
  snapshotGraph,
} from "./prune-harness.js";
import type { ClassificationLogRow, LogRowSeed } from "./prune-harness.js";

useDomainPrefix("prune-retention");

/** One preserved-after-failure event of one candidate, at a chosen age. */
function failure(
  stackId: string,
  candidateRef: string,
  ageInMinutes: number,
): LogRowSeed {
  return {
    stackId,
    candidateRef,
    reason: `${FAILURE_REASON_PREFIX}:failed`,
    ageInMinutes,
  };
}

/** The prune call every test makes, so the runner wiring is written once. */
function prune(stackId: string, confirm: boolean) {
  return pruneClassificationFailures(createTransactionRunner(database()), {
    stackId,
    confirm,
  });
}

/**
 * How many failure events the newest end of one candidate's history holds.
 *
 * Read from `oldest first` history, walking backwards until something that is not a
 * failure event stops the run — the exact count an operator would compute by eye.
 */
function trailingFailureRun(
  history: readonly ClassificationLogRow[],
  candidateRef: string,
): number {
  const events = history.filter((row) => row.candidate_ref === candidateRef);
  let run = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!(events[index]?.reason ?? "").startsWith(FAILURE_REASON_PREFIX)) break;
    run += 1;
  }
  return run;
}

/** A failure run of `count` events, the newest `newestAgeInMinutes` old. */
function failureRun(
  stackId: string,
  candidateRef: string,
  count: number,
  newestAgeInMinutes: number,
): readonly LogRowSeed[] {
  return Array.from({ length: count }, (_, index) =>
    failure(stackId, candidateRef, newestAgeInMinutes + index),
  );
}

describe.skipIf(skipReason !== false)("what a failure prune must not delete", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  it("leaves classification state, evidence, entities and relations byte-identical", async () => {
    const stackId = await createStack();
    await seedGraphFixture(stackId);
    await seedLogRows([
      failure(stackId, "old-one", 40 * MINUTES_PER_DAY),
      failure(stackId, "old-two", 45 * MINUTES_PER_DAY),
    ]);
    const before = await snapshotGraph(stackId);
    // A snapshot of nothing would make the equality below prove nothing.
    expect(before.entities).toHaveLength(2);
    expect(before.relations).toHaveLength(1);
    expect(before.evidence).toHaveLength(1);
    expect(before.classificationStates).toHaveLength(2);

    const outcome = await prune(stackId, true);

    expect(outcome).toMatchObject({ matchedCount: 2, deletedCount: 2 });
    expect(await snapshotGraph(stackId)).toEqual(before);
  });

  it("still reads a candidate that failed 47 times as 47 consecutive failures", async () => {
    const stackId = await createStack();
    const candidateRef = "failing-candidate";
    await seedLogRows([
      // Outside the window: pruned, so the tail of the run stops being observable.
      failure(stackId, candidateRef, 45 * MINUTES_PER_DAY),
      ...failureRun(stackId, candidateRef, 5, 40 * MINUTES_PER_DAY),
      // A real state change, also outside the window. It is NOT eligible, so it
      // survives and is what bounds the run from below.
      {
        stackId,
        candidateRef,
        reason: "classification_changed",
        ageInMinutes: 50 * MINUTES_PER_DAY,
      },
      // Inside the window: the 47 events the count must still report.
      ...failureRun(stackId, candidateRef, 47, 10),
    ]);

    const outcome = await prune(stackId, true);

    expect(outcome).toMatchObject({ matchedCount: 6, deletedCount: 6 });
    const history = await logRows(stackId);
    expect(history).toHaveLength(48);
    expect(history[0]?.reason).toBe("classification_changed");
    expect(trailingFailureRun(history, candidateRef)).toBe(47);
  });

  it("deletes each eligible row exactly once across two concurrent prunes", async () => {
    const stackId = await createStack();
    const eligible = 25;
    await seedLogRows([
      ...failureRun(stackId, "old", eligible, 40 * MINUTES_PER_DAY),
      failure(stackId, "recent", 1 * MINUTES_PER_DAY),
    ]);

    const outcomes = await Promise.all([prune(stackId, true), prune(stackId, true)]);

    const deleted = outcomes.reduce((total, outcome) => total + outcome.deletedCount, 0);
    const matched = outcomes.reduce((total, outcome) => total + outcome.matchedCount, 0);
    // Serialized, not raced: the second run counts AFTER the first commits, so the two
    // reports describe the same 25 rows once each and never the same row twice.
    expect(matched).toBe(eligible);
    expect(deleted).toBe(eligible);
    expect((await logRows(stackId)).map((row) => row.candidate_ref)).toEqual(["recent"]);
  });
});
