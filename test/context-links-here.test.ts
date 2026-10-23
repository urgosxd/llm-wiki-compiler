/**
 * @file Unit tests for inbound link resolution (`findInboundLinks`).
 *
 * The compiled wiki only records the direction each page casts, so this module
 * is what makes the reverse question answerable: given a concept, which other
 * concepts point at it? The tests pin the four rules the implementation
 * inherits from the existing graph code — inbound direction, mutual detection,
 * ghost exclusion, and deterministic ordering — because a wrong answer here
 * silently misleads a reader about how the wiki is connected.
 */

import { describe, expect, it } from "vitest";
import { findInboundLinks } from "../src/context/links-here.js";
import { syntheticGraph } from "./fixtures/graph-data.js";
import type { PageId } from "../src/viewer/types.js";

/** Compose synthetic graph data from real ids, directed edges, and ghosts. */
function graph(realIds: PageId[], edges: [PageId, PageId][], ghostIds: PageId[] = []) {
  return syntheticGraph({ realIds, edges, ghostIds });
}

const A = "concepts/alpha" as PageId;
const B = "concepts/beta" as PageId;
const C = "concepts/gamma" as PageId;

describe("findInboundLinks", () => {
  it("returns the page that links TO the target, not the one it links to", () => {
    const data = graph([A, B], [[A, B]]);
    expect(findInboundLinks(data, B)).toEqual([{ from: A, mutual: false }]);
  });

  it("reports no inbound links for the page that only links out", () => {
    const data = graph([A, B], [[A, B]]);
    expect(findInboundLinks(data, A)).toEqual([]);
  });

  it("marks a bidirectional pair as mutual", () => {
    const data = graph([A, B], [[A, B], [B, A]]);
    expect(findInboundLinks(data, B)).toEqual([{ from: A, mutual: true }]);
  });

  it("lists multiple inbound pages in deterministic id order", () => {
    const data = graph([A, B, C], [[C, B], [A, B]]);
    expect(findInboundLinks(data, B).map((link) => link.from)).toEqual([A, C]);
  });

  it("de-duplicates a repeated edge from the same source", () => {
    const data = graph([A, B], [[A, B], [A, B]]);
    expect(findInboundLinks(data, B)).toHaveLength(1);
  });

  it("excludes a dangling source that has no backing page", () => {
    const ghost = "concepts/ghost" as PageId;
    const data = graph([B], [[ghost, B]], [ghost]);
    expect(findInboundLinks(data, B)).toEqual([]);
  });

  it("returns nothing for a page nothing points at yet", () => {
    const data = graph([A], []);
    expect(findInboundLinks(data, A)).toEqual([]);
  });
});
