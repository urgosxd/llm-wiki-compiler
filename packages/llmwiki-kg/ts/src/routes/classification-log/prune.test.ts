/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/prune.test.ts
 * @description What an administrative failure prune is allowed to delete, and what it
 * must therefore report instead of deleting.
 *
 * WHY THIS FILE EXISTS. `kg_classification_log` is an append-only event log: a
 * permanently failing classifier appends one `provider_failure_preserved:*` row per
 * sweep per candidate, and that per-occurrence record is a diagnostic signal nobody
 * may dedupe at write time. The table still has to stay bounded, so retention is a
 * separate, explicit, time-window DELETE. This file pins the four properties that make
 * that operation safe to run by hand:
 *
 * - only events OLDER than the window of one Stack are eligible, so the tail of the
 *   window stays readable;
 * - nothing else in the table is eligible — a refusal is state, and a refusal row of
 *   any age survives, which is asserted against the literal operator-visible strings;
 * - without explicit confirmation nothing is deleted and the count is reported, so the
 *   default answer is "here is what would go", never "gone";
 * - a second run over an already-pruned table matches zero and deletes zero, and a
 *   window outside the accepted range is rejected before anything is touched.
 *
 * The observable outcome of every case is the returned report PLUS the surviving
 * history, because a count that disagrees with the table is the failure mode a prune
 * can never be allowed to have.
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
import { VERIFIED_REFUSAL_REASON } from "../reclassify/persist.js";
import {
  DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS,
  FAILURE_REASON_PREFIX,
  MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS,
  pruneClassificationFailures,
} from "./prune.js";
import { logRows, MINUTES_PER_DAY, seedLogRows } from "./prune-harness.js";
import type { LogRowSeed } from "./prune-harness.js";

useDomainPrefix("prune");

/** The reason a sweep records when an outage left a stored decision untouched. */
function failureReason(state: "failed" | "pending" = "failed"): string {
  return `${FAILURE_REASON_PREFIX}:${state}`;
}

/** One preserved-after-failure event of one candidate, at a chosen age. */
function failure(
  stackId: string,
  candidateRef: string,
  ageInMinutes: number,
): LogRowSeed {
  return { stackId, candidateRef, reason: failureReason(), ageInMinutes };
}

/** The prune call every test makes, so the runner wiring is written once. */
function prune(
  stackId: string,
  options: { retentionDays?: number; confirm?: boolean } = {},
) {
  return pruneClassificationFailures(createTransactionRunner(database()), {
    stackId,
    ...options,
  });
}

/** The candidate refs a Stack's surviving history holds, in history order. */
async function survivingRefs(stackId: string): Promise<readonly string[]> {
  return (await logRows(stackId)).map((row) => row.candidate_ref);
}

describe.skipIf(skipReason !== false)("classification failure retention", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  it("prunes failure events older than the window and keeps the newer ones", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "candidate-old", 40 * MINUTES_PER_DAY),
      failure(stackId, "candidate-recent", 1 * MINUTES_PER_DAY),
    ]);

    const outcome = await prune(stackId, { confirm: true });

    expect(outcome).toMatchObject({
      dryRun: false,
      retentionDays: DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS,
      matchedCount: 1,
      deletedCount: 1,
    });
    // The cutoff is reported so an operator can see WHICH window ran, and it is a
    // timestamp rather than an internal type of the driver.
    expect(typeof outcome.cutoff).toBe("string");
    expect(Number.isNaN(Date.parse(outcome.cutoff))).toBe(false);
    expect(await survivingRefs(stackId)).toEqual(["candidate-recent"]);
  });

  it("keeps every row that is not a failure event, however old it is", async () => {
    const stackId = await createStack();
    const old = 40 * MINUTES_PER_DAY;
    await seedLogRows([
      failure(stackId, "old-failure", old),
      { stackId, candidateRef: "verified", reason: VERIFIED_REFUSAL_REASON, ageInMinutes: old },
      // A decoy: the failure prefix with dashes instead of underscores. It must not be
      // mistaken for the family under retention, which is why the statement escapes
      // `_`, a LIKE wildcard that would otherwise match it.
      { stackId, candidateRef: "lookalike", reason: "provider-failure-preserved:failed", ageInMinutes: old },
    ]);

    const outcome = await prune(stackId, { confirm: true });

    expect(outcome).toMatchObject({ matchedCount: 1, deletedCount: 1 });
    expect([...(await survivingRefs(stackId))].sort()).toEqual(["lookalike", "verified"]);
    // The operator-visible contract is these exact strings: a constant that drifted
    // would silently change which family is pruned.
    expect(FAILURE_REASON_PREFIX).toBe("provider_failure_preserved:");
    expect(VERIFIED_REFUSAL_REASON).toBe("refused:verified_row_preserved");
  });

  it("reports the matched count and deletes nothing without confirmation", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "old-one", 40 * MINUTES_PER_DAY),
      failure(stackId, "old-two", 50 * MINUTES_PER_DAY),
      failure(stackId, "recent", 1 * MINUTES_PER_DAY),
    ]);
    const before = await logRows(stackId);

    const outcome = await prune(stackId);

    expect(outcome).toMatchObject({
      dryRun: true,
      retentionDays: DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS,
      matchedCount: 2,
      deletedCount: 0,
    });
    expect(await logRows(stackId)).toEqual(before);
  });

  it("matches and deletes nothing on a second run over a pruned table", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "old-one", 40 * MINUTES_PER_DAY),
      failure(stackId, "old-two", 45 * MINUTES_PER_DAY),
      failure(stackId, "recent", 1 * MINUTES_PER_DAY),
    ]);

    const first = await prune(stackId, { confirm: true });
    const second = await prune(stackId, { confirm: true });

    expect(first).toMatchObject({ matchedCount: 2, deletedCount: 2 });
    expect(second).toMatchObject({
      dryRun: false,
      matchedCount: 0,
      deletedCount: 0,
    });
    expect(await survivingRefs(stackId)).toEqual(["recent"]);
  });

  it("rejects a retention window outside the accepted range and deletes nothing", async () => {
    const stackId = await createStack();
    await seedLogRows([failure(stackId, "old", 40 * MINUTES_PER_DAY)]);
    const before = await logRows(stackId);

    await expect(prune(stackId, { confirm: true, retentionDays: 0 })).rejects.toThrow(RangeError);
    await expect(
      prune(stackId, { confirm: true, retentionDays: MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS + 1 }),
    ).rejects.toThrow(RangeError);
    await expect(prune(stackId, { confirm: true, retentionDays: 1.5 })).rejects.toThrow(RangeError);

    expect(await logRows(stackId)).toEqual(before);
    // The bound is a named constant an operator can read, not a number buried in a
    // comparison.
    expect(MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS).toBe(3650);
  });
});
