/**
 * @file test/dimensions/marker-store.test.ts
 * @description The three small per-project markers, as rows.
 *
 * The property worth asserting is not that a marker round-trips. It is that a marker
 * write REPLACES the set: the file was rewritten whole on every settle, so an id that
 * succeeded must disappear. A merge would leave it queued forever — the failure that
 * makes a retry marker worse than no marker, because it retries something already done.
 *
 * Quarantine is also asserted as a SEPARATE state rather than a second file, since
 * collapsing the two was the one design decision this migration made.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCachedLintResult,
  readRefreshMarkers,
  readRuleExtractorState,
  replaceRefreshMarkers,
  writeCachedLintResult,
  writeRuleExtractorState,
} from "../../src/dimensions/wiki/marker-store.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { createProbeStack } from "./harness-lifecycle.js";

let harness: KgPostgresHarness;

beforeEach(async () => {
  harness = (await createProbeStack("marker")).harness;
});

afterEach(async () => {
  await harness.cleanup();
});

describe("pending embedding markers", () => {
  it("reads empty on a Stack that never queued a refresh", async () => {
    expect(await readRefreshMarkers(harness.db, harness.stackId, "pending")).toEqual([]);
  });

  it("round-trips entries with their attempt counts", async () => {
    await replaceRefreshMarkers(harness.db, harness.stackId, "pending", [
      { pageId: "concepts/alpha", attempts: 2 },
    ]);

    expect(await readRefreshMarkers(harness.db, harness.stackId, "pending"))
      .toEqual([{ pageId: "concepts/alpha", attempts: 2 }]);
  });

  it("REPLACES the set, so a settled id disappears instead of being retried", async () => {
    await replaceRefreshMarkers(harness.db, harness.stackId, "pending", [
      { pageId: "concepts/alpha", attempts: 1 },
      { pageId: "concepts/beta", attempts: 1 },
    ]);
    // `alpha` succeeded, so the caller's new list omits it.
    await replaceRefreshMarkers(harness.db, harness.stackId, "pending", [
      { pageId: "concepts/beta", attempts: 2 },
    ]);

    const remaining = await readRefreshMarkers(harness.db, harness.stackId, "pending");
    expect(remaining).toEqual([{ pageId: "concepts/beta", attempts: 2 }]);
  });

  it("clears completely when the caller passes an empty set", async () => {
    await replaceRefreshMarkers(harness.db, harness.stackId, "pending", [
      { pageId: "concepts/alpha", attempts: 1 },
    ]);
    await replaceRefreshMarkers(harness.db, harness.stackId, "pending", []);

    expect(await readRefreshMarkers(harness.db, harness.stackId, "pending")).toEqual([]);
  });

  it("keeps quarantined entries apart from pending ones", async () => {
    // One table, one shape, two states: the distinction the two files encoded.
    await replaceRefreshMarkers(harness.db, harness.stackId, "pending", [
      { pageId: "concepts/retry", attempts: 1 },
    ]);
    await replaceRefreshMarkers(harness.db, harness.stackId, "quarantined", [
      { pageId: "concepts/poison", attempts: 5 },
    ]);

    expect(await readRefreshMarkers(harness.db, harness.stackId, "pending"))
      .toEqual([{ pageId: "concepts/retry", attempts: 1 }]);
    expect(await readRefreshMarkers(harness.db, harness.stackId, "quarantined"))
      .toEqual([{ pageId: "concepts/poison", attempts: 5 }]);
  });
});

describe("lint cache", () => {
  it("reads as absent when nothing is cached", async () => {
    expect(await readCachedLintResult(harness.db, harness.stackId)).toBeUndefined();
  });

  it("round-trips findings and counts, replacing the previous result", async () => {
    await writeCachedLintResult(harness.db, harness.stackId, {
      inputHash: "h1", findings: [{ rule: "a" }], errorCount: 1, warningCount: 0,
    });
    await writeCachedLintResult(harness.db, harness.stackId, {
      inputHash: "h2", findings: [], errorCount: 0, warningCount: 0,
    });

    expect(await readCachedLintResult(harness.db, harness.stackId)).toEqual({
      inputHash: "h2", findings: [], errorCount: 0, warningCount: 0,
    });
  });
});

describe("rule extractor state", () => {
  it("reads as absent before the extractor ever ran", async () => {
    expect(await readRuleExtractorState(harness.db, harness.stackId)).toBeUndefined();
  });

  it("round-trips an arbitrary snapshot", async () => {
    const snapshot = { version: 1, indexHash: "", sources: { "sources/a.md": { hash: "h" } } };
    await writeRuleExtractorState(harness.db, harness.stackId, snapshot);

    expect(await readRuleExtractorState(harness.db, harness.stackId)).toEqual(snapshot);
  });
});
