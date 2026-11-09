/**
 * @file Unit tests for wiki-race path traversal (`findRacePath`).
 *
 * THE MECHANIC. A wiki race is the game of getting from page A to page B using
 * only the links that already exist inside the articles. For that to be
 * playable by an agent and fair between two humans, three properties have to
 * hold: the walk follows OUTGOING links only, several equally short routes
 * resolve to ONE stated winner, and the depth bound is a number the caller can
 * see rather than a hidden cut-off.
 *
 * Every case below drives the exported function with synthetic graph data, so
 * the assertions are about the traversal contract itself and never about how
 * the adjacency happens to be stored.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RACE_MAX_DEPTH,
  RACE_MAX_DEPTH_CEILING,
  findRacePath,
  resolveRaceMaxDepth,
} from "../../packages/wiki/src/context/race-path.js";
import { syntheticGraph } from "../fixtures/graph-data.js";
import type { GraphData, PageId } from "../../packages/wiki/src/viewer/types.js";

const A = "concepts/alpha" as PageId;
const B = "concepts/beta" as PageId;
const C = "concepts/gamma" as PageId;
const D = "concepts/delta" as PageId;

/** Compose synthetic graph data from real ids, directed edges, and ghosts. */
function graph(
  realIds: PageId[],
  edges: [PageId, PageId][],
  ghostIds: PageId[] = [],
): GraphData {
  return syntheticGraph({ realIds, edges, ghostIds });
}

describe("findRacePath — routes", () => {
  it("returns a one-hop route for a direct link", () => {
    const result = findRacePath(graph([A, B], [[A, B]]), { from: A, to: B });
    expect(result.found).toBe(true);
    expect(result.route).toEqual([A, B]);
    expect(result.hops).toBe(1);
    expect(result.reason).toBe(null);
  });

  it("returns the full chain for a multi-hop route", () => {
    const result = findRacePath(graph([A, B, C], [[A, B], [B, C]]), { from: A, to: C });
    expect(result.route).toEqual([A, B, C]);
    expect(result.hops).toBe(2);
  });

  it("returns the zero-length route when start and target are the same page", () => {
    const result = findRacePath(graph([A], []), { from: A, to: A });
    expect(result.found).toBe(true);
    expect(result.route).toEqual([A]);
    expect(result.hops).toBe(0);
    expect(result.depthBoundReached).toBe(false);
  });

  it("does not walk links backwards", () => {
    const result = findRacePath(graph([A, B], [[A, B]]), { from: B, to: A });
    expect(result.found).toBe(false);
    expect(result.route).toEqual([]);
    expect(result.reason).toBe("no-path");
  });
});

describe("findRacePath — determinism", () => {
  it("picks the ascending page id when two shortest routes tie", () => {
    // Adversarial order on purpose: `gamma` is the first node and the first edge
    // of `alpha`, so an implementation that inherits insertion or filesystem
    // order answers alpha -> gamma -> delta. The rule is ascending page id, so
    // the winner is alpha -> beta -> delta.
    const data = graph(
      [D, C, B, A],
      [[A, C], [C, D], [A, B], [B, D]],
    );
    const result = findRacePath(data, { from: A, to: D });
    expect(result.route).toEqual([A, B, D]);
    expect(result.hops).toBe(2);
  });

  it("returns the same route for the same wiki regardless of edge order", () => {
    const forward = graph([A, B, C, D], [[A, C], [C, D], [A, B], [B, D]]);
    const reversed = graph([A, B, C, D], [[A, B], [B, D], [A, C], [C, D]]);
    const first = findRacePath(forward, { from: A, to: D });
    const second = findRacePath(reversed, { from: A, to: D });
    expect(first.route).toEqual(second.route);
    expect(first.route).toEqual([A, B, D]);
  });
});

describe("findRacePath — ghosts and bounds", () => {
  it("rejects a route whose intermediate stop is a dangling ghost", () => {
    const ghost = "concepts/nowhere" as PageId;
    const data = graph([A, D], [[A, ghost], [ghost, D]], [ghost]);
    const result = findRacePath(data, { from: A, to: D });
    expect(result.found).toBe(false);
    expect(result.route).toEqual([]);
    expect(result.reason).toBe("no-path");
  });

  it("rejects a dangling target reached directly from the start", () => {
    const ghost = "concepts/nowhere" as PageId;
    const data = graph([A], [[A, ghost]], [ghost]);
    expect(findRacePath(data, { from: A, to: ghost }).found).toBe(false);
  });

  it("names the depth bound as the reason when the target lies beyond it", () => {
    const result = findRacePath(graph([A, B, C], [[A, B], [B, C]]), {
      from: A,
      to: C,
      maxDepth: 1,
    });
    expect(result.found).toBe(false);
    expect(result.route).toEqual([]);
    expect(result.hops).toBe(0);
    expect(result.depthBoundReached).toBe(true);
    expect(result.reason).toBe("depth-bound");
    expect(result.maxDepth).toBe(1);
  });

  it("finds the same pair once the depth bound is raised", () => {
    const data = graph([A, B, C], [[A, B], [B, C]]);
    expect(findRacePath(data, { from: A, to: C, maxDepth: 2 }).route).toEqual([A, B, C]);
  });

  it("reports an exhausted search as no-path, not as a bound", () => {
    const result = findRacePath(graph([A, B], []), { from: A, to: B, maxDepth: 3 });
    expect(result.found).toBe(false);
    expect(result.depthBoundReached).toBe(false);
    expect(result.reason).toBe("no-path");
  });

  it("defaults to the named maximum depth", () => {
    expect(findRacePath(graph([A, B], [[A, B]]), { from: A, to: B }).maxDepth)
      .toBe(DEFAULT_RACE_MAX_DEPTH);
  });
});

describe("resolveRaceMaxDepth", () => {
  it("falls back to the named default", () => {
    expect(resolveRaceMaxDepth(undefined)).toBe(DEFAULT_RACE_MAX_DEPTH);
  });

  it("clamps a request above the named ceiling", () => {
    expect(resolveRaceMaxDepth(RACE_MAX_DEPTH_CEILING + 100)).toBe(RACE_MAX_DEPTH_CEILING);
  });

  it("rejects a negative or fractional bound instead of guessing", () => {
    expect(() => resolveRaceMaxDepth(-1)).toThrow(/max-depth/i);
    expect(() => resolveRaceMaxDepth(1.5)).toThrow(/max-depth/i);
  });
});
