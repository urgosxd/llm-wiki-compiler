/**
 * @file test/context/graph-health.test.ts
 * @description Z4, Z5 and Z6: the graph-health measurement over the EXISTING link graph
 * reports the shortest-path depth distribution and the unreachable count, respects and
 * reports its sampled-pair cap, and produces byte-identical output for the same graph.
 *
 * WHY BOTH NUMBERS AND NOT AN AVERAGE. "Average hops" can be moved by over-linking a
 * single hub, so it cannot say whether a wiki is navigable. Depth DISTRIBUTION plus the
 * count of ordered pairs with no route at all can be gamed only by making the graph
 * genuinely more connected, and both are asserted here against hand-computed values on
 * a graph small enough to count by hand.
 *
 * WHY THE CAP IS TESTED TWICE. A bound nobody can see is the silent limit the feature
 * forbids: the report carries the cap, whether it cut the sample, and how many pairs were
 * actually walked, and raising the cap has to change that count or the bound is a lie.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeGraphHealth,
  resolveGraphHealthPairCap,
  DEFAULT_GRAPH_HEALTH_PAIR_CAP,
} from "../../src/context/graph-health.js";
import { syntheticGraph } from "../fixtures/graph-data.js";
import type { GraphData, PageId } from "../../src/viewer/types.js";

const A = "concepts/alpha" as PageId;
const B = "concepts/beta" as PageId;
const C = "concepts/gamma" as PageId;
const D = "concepts/delta" as PageId;

/** Alpha → beta → gamma, with delta reachable from nowhere. Four pages, twelve pairs. */
function chainWithIsland(): GraphData {
  return syntheticGraph({ realIds: [A, B, C, D], edges: [[A, B], [B, C]] });
}

describe("analyzeGraphHealth — the numbers", () => {
  it("Z4 reports the exact depth histogram and unreachable count of a known shape", () => {
    const report = analyzeGraphHealth(chainWithIsland());
    expect(report.pages).toBe(4);
    expect(report.totalPairs).toBe(12);
    expect(report.consideredPairs).toBe(12);
    expect(report.truncated).toBe(false);
    expect(report.depthHistogram).toEqual([{ depth: 1, pairs: 2 }, { depth: 2, pairs: 1 }]);
    expect(report.reachablePairs).toBe(3);
    expect(report.unreachablePairs).toBe(9);
    expect(report.deepestReachable).toBe(2);
    expect(report.meanDepth).toBe(1.33);
  });

  it("Z4 excludes a dangling target from the pair set, as the graph already does", () => {
    const graph = syntheticGraph({
      realIds: [A, B],
      edges: [[A, B], [B, "concepts/nowhere" as PageId]],
      ghostIds: ["concepts/nowhere" as PageId],
    });
    const report = analyzeGraphHealth(graph);
    expect(report.pages).toBe(2);
    expect(report.totalPairs).toBe(2);
    expect(report.reachablePairs).toBe(1);
    expect(report.unreachablePairs).toBe(1);
  });

  it("Z4 says a shallow graph is shallow instead of hiding it", () => {
    const report = analyzeGraphHealth(chainWithIsland());
    expect(report.observation).toContain("2 hop(s) or fewer");
  });

  it("Z4 reports no observation for a graph that needs more than two hops", () => {
    const deep = syntheticGraph({ realIds: [A, B, C, D], edges: [[A, B], [B, C], [C, D]] });
    const report = analyzeGraphHealth(deep);
    expect(report.deepestReachable).toBe(3);
    expect(report.observation).toBeNull();
  });

  it("Z4 measures an empty wiki as empty, not as a failure", () => {
    const report = analyzeGraphHealth({ nodes: [], edges: [] });
    expect(report.pages).toBe(0);
    expect(report.totalPairs).toBe(0);
    expect(report.consideredPairs).toBe(0);
    expect(report.depthHistogram).toEqual([]);
    expect(report.meanDepth).toBeNull();
    expect(report.observation).toBeNull();
  });
});

describe("analyzeGraphHealth — the sampled-pair cap", () => {
  it("Z5 respects and reports a cap smaller than the pair set", () => {
    const report = analyzeGraphHealth(chainWithIsland(), { pairCap: 5 });
    expect(report.pairCap).toBe(5);
    expect(report.totalPairs).toBe(12);
    expect(report.consideredPairs).toBe(5);
    expect(report.truncated).toBe(true);
    // The first five pairs in id order (alpha, beta, delta, gamma): alpha→beta and
    // alpha→gamma are the only two that resolve.
    expect(report.reachablePairs).toBe(2);
  });

  it("Z5 raising the cap raises the considered-pair count", () => {
    const graph = chainWithIsland();
    const small = analyzeGraphHealth(graph, { pairCap: 5 });
    const larger = analyzeGraphHealth(graph, { pairCap: 12 });
    expect(larger.consideredPairs).toBeGreaterThan(small.consideredPairs);
    expect(larger.consideredPairs).toBe(12);
    expect(larger.truncated).toBe(false);
    expect(DEFAULT_GRAPH_HEALTH_PAIR_CAP).toBeGreaterThan(12);
  });

  it("Z5 rejects a cap that is not a non-negative integer", () => {
    expect(() => resolveGraphHealthPairCap("-1")).toThrow(/non-negative integer/);
    expect(() => resolveGraphHealthPairCap("2.5")).toThrow(/non-negative integer/);
    expect(resolveGraphHealthPairCap(undefined)).toBe(DEFAULT_GRAPH_HEALTH_PAIR_CAP);
    expect(resolveGraphHealthPairCap("7")).toBe(7);
  });
});

describe("analyzeGraphHealth — determinism", () => {
  it("Z6 two runs over the same graph produce identical reports", async () => {
    const graph = chainWithIsland();
    const first = JSON.stringify(analyzeGraphHealth(graph));
    const second = JSON.stringify(analyzeGraphHealth(graph));
    expect(first).toBe(second);
    // Same graph, edges listed in the opposite order: the answer must not move.
    const reordered: GraphData = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    expect(JSON.stringify(analyzeGraphHealth(reordered))).toBe(first);
  });
});
