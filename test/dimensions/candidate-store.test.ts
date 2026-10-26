/**
 * @file test/dimensions/candidate-store.test.ts
 * @description Pending review candidates over rows.
 *
 * The property that matters is PARITY: `ReviewCandidate` is a serialized JSON
 * document that the reviewer, the CLI and the approver all consume, so a round trip
 * must preserve it exactly — including which OPTIONAL fields are absent, because
 * `review show` prints an absent `trustDecision` differently from an empty one.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteStoredCandidate,
  getStoredCandidate,
  listStoredCandidates,
  saveStoredCandidate,
} from "../../src/dimensions/wiki/candidate-store.js";
import type { ReviewCandidate } from "../../src/utils/types.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { createProbeStack } from "./harness-lifecycle.js";

let harness: KgPostgresHarness;

beforeEach(async () => {
  harness = (await createProbeStack("cand")).harness;
});

afterEach(async () => {
  await harness.cleanup();
});

/** A minimal candidate with every REQUIRED field and no optionals. */
function minimalCandidate(id: string): ReviewCandidate {
  return {
    id,
    title: "Alpha",
    slug: "alpha",
    summary: "a summary",
    sources: ["sources/a.md"],
    body: "---\ntitle: Alpha\n---\n\nbody\n",
    generatedAt: "2026-02-01T10:00:00.000Z",
    reviewMode: "policy",
    heldReasons: [{ code: "manual-review-requested" } as never],
    targetDirectory: "concepts",
  };
}

describe("review candidates as rows", () => {
  it("lists nothing on a Stack with no queue", async () => {
    expect(await listStoredCandidates(harness.db, harness.stackId)).toEqual([]);
  });

  it("round-trips a candidate without inventing optional fields", async () => {
    const candidate = minimalCandidate("cand_1");
    await saveStoredCandidate(harness.db, harness.stackId, candidate);

    const stored = await getStoredCandidate(harness.db, harness.stackId, "cand_1");
    expect(stored).toEqual(candidate);
    // An absent optional must STAY absent: `review show` distinguishes it.
    expect("trustDecision" in (stored ?? {})).toBe(false);
    expect("expectedTargetHash" in (stored ?? {})).toBe(false);
    expect("expectTargetAbsent" in (stored ?? {})).toBe(false);
  });

  it("round-trips every optional field when present", async () => {
    const candidate: ReviewCandidate = {
      ...minimalCandidate("cand_2"),
      targetEntityType: "papers",
      trustDecision: "allow" as never,
      expectedTargetHash: "abc123",
      okfPath: "bundle/doc.md",
      promptModifiers: "digest-1",
      schemaViolations: [{ rule: "x" } as never],
      sourceStates: { "sources/a.md": { hash: "h", concepts: ["alpha"], compiledAt: "2026-02-01T10:00:00.000Z", version: 2 } },
    };
    await saveStoredCandidate(harness.db, harness.stackId, candidate);

    expect(await getStoredCandidate(harness.db, harness.stackId, "cand_2")).toEqual(candidate);
  });

  it("keeps expectTargetAbsent distinct from absent", async () => {
    // The interface omits the flag when false; a row stores false. A round trip must
    // preserve the OMISSION, not turn it into `expectTargetAbsent: false`.
    await saveStoredCandidate(harness.db, harness.stackId, {
      ...minimalCandidate("cand_3"), expectTargetAbsent: true,
    });

    const stored = await getStoredCandidate(harness.db, harness.stackId, "cand_3");
    expect(stored?.expectTargetAbsent).toBe(true);
  });

  it("replaces a candidate with the same id instead of duplicating", async () => {
    await saveStoredCandidate(harness.db, harness.stackId, minimalCandidate("cand_4"));
    await saveStoredCandidate(harness.db, harness.stackId, {
      ...minimalCandidate("cand_4"), title: "Renamed",
    });

    const queue = await listStoredCandidates(harness.db, harness.stackId);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.title).toBe("Renamed");
  });

  it("keeps one Stack's queue invisible to another", async () => {
    // The defect this fixes: the file store was scoped to a CHECKOUT, so two hosts
    // reviewing one Stack kept two queues and neither saw the other's candidates.
    const other = (await createProbeStack("cand-b")).harness;
    try {
      await saveStoredCandidate(harness.db, harness.stackId, minimalCandidate("cand_iso"));

      expect(await listStoredCandidates(harness.db, harness.stackId)).toHaveLength(1);
      expect(await listStoredCandidates(other.db, other.stackId)).toEqual([]);
      expect(await getStoredCandidate(other.db, other.stackId, "cand_iso")).toBeUndefined();
    } finally {
      await other.cleanup();
    }
  });

  it("reports whether a delete consumed a real queue entry", async () => {
    await saveStoredCandidate(harness.db, harness.stackId, minimalCandidate("cand_5"));

    expect(await deleteStoredCandidate(harness.db, harness.stackId, "cand_5")).toBe(true);
    // Already gone: the same call is a no-op, which is the caller's signal that the
    // queue entry was consumed by someone else.
    expect(await deleteStoredCandidate(harness.db, harness.stackId, "cand_5")).toBe(false);
  });
});
