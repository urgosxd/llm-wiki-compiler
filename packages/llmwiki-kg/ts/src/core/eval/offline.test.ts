/**
 * @file packages/llmwiki-kg/ts/src/core/eval/offline.test.ts
 * @description The offline runner over the shipped labeled set, with no network.
 *
 * This is the evaluation a developer and CI can actually run. It drives the real
 * classification and interpretation path with the scripted double, so what it
 * measures is the scorer's behaviour on committed labels rather than the vendor's
 * behaviour on the day. Two properties it pins beyond the numbers: the free
 * predicate `deja sin efecto` survives verbatim in the decision (a free relation
 * keeps its meaning), and the four axes are each populated, because an axis that
 * silently measures nothing is worse than a bad number.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEvalSet } from "./load.js";
import { runOfflineEval } from "./offline.js";

const SET = loadEvalSet();

describe("runOfflineEval", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the offline evaluation must never open a socket");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scores every axis over the shipped set without touching the network", async () => {
    const run = await runOfflineEval({ set: SET });
    const report = run.report;
    expect(report.run).toEqual({ mode: "offline", model: "jev-recorded", baseUrl: null });
    expect(report.classification.evaluated).toBeGreaterThan(0);
    expect(report.support.judged).toBeGreaterThan(0);
    expect(report.informationLoss.candidates).toBeGreaterThan(0);
    expect(report.extractorCoverage.produced).toBeGreaterThan(0);
    expect(report.extractorCoverage.omitted).toBeGreaterThan(0);
  });

  it("keeps a free relation's original predicate verbatim", async () => {
    const run = await runOfflineEval({ set: SET });
    const free = run.decisions.find((decision) => decision.kind === "relationship" && decision.predicate === "deja sin efecto");
    expect(free?.classificationState).toBe("free_no_match");
    expect(free?.canonicalType).toBeNull();
  });

  it("records the labeled facts the extractor never produced", async () => {
    const run = await runOfflineEval({ set: SET });
    const omitted = SET.examples.filter((example) => !example.extracted).map((example) => example.id);
    expect(run.report.extractorCoverage.omittedIds).toEqual(omitted);
  });
});
