/**
 * @file test/dimensions/wiki-concept-forest.test.ts
 * @description Group construction refuses any evidence tier that is not a
 * deterministic identity rule.
 *
 * The union-find is where two candidates become one concept, so it is also the only
 * place where a similarity score could smuggle itself into identity. The vocabulary
 * of retired ranks (`auto`, `review`) is gone; what this file proves is that the
 * protection survives the vocabulary's removal: an untyped caller -- or a future
 * refactor that casts its way past the compiler -- cannot join two candidates at a
 * score-derived tier, and no rank outside the deterministic rules is ever reported.
 */

import { describe, it, expect } from "vitest";

import {
  createConceptForest,
  groupsByRoot,
  isDeterministicTier,
  tierOfRoot,
  tierThatJoined,
  unionCandidates,
  type ConceptForest,
} from "../../packages/wiki/src/dimensions/wiki/concept-forest.js";

/** The ranks similarity used to produce, still reachable from JavaScript callers. */
const RETIRED_SCORE_TIERS = ["auto", "review"];

/** Root of `node`, for asserting what a group reports. */
function rootOf(forest: ConceptForest, node: number): number {
  for (const [root, members] of groupsByRoot(forest, forest.parent.length)) {
    if (members.includes(node)) return root;
  }
  return -1;
}

describe("group construction refuses a score-derived tier", () => {
  it("throws instead of joining two candidates at a similarity tier", () => {
    // `auto` and `review` are the two ranks a cosine threshold used to produce. They
    // are not in the vocabulary any more, which is why the cast is needed to ask.
    for (const retired of RETIRED_SCORE_TIERS) {
      const forest = createConceptForest(2);
      expect(() => unionCandidates(forest, 0, 1, retired as never))
        .toThrow(`${retired}" is not a deterministic identity rule`);
    }
  });

  it("leaves the forest untouched when a score-derived tier is refused", () => {
    const forest = createConceptForest(2);
    expect(() => unionCandidates(forest, 0, 1, "auto" as never)).toThrow();
    expect(groupsByRoot(forest, 2)).toEqual(new Map([[0, [0]], [1, [1]]]));
  });

  it("names only the name rules as deterministic identity tiers", () => {
    expect(isDeterministicTier("slug")).toBe(true);
    expect(isDeterministicTier("normalized")).toBe(true);
    for (const refused of [...RETIRED_SCORE_TIERS, "alias", ""]) {
      expect(isDeterministicTier(refused)).toBe(false);
    }
  });
});

describe("group construction at a deterministic tier", () => {
  it("joins two candidates and reports the tier that justified the group", () => {
    const forest = createConceptForest(2);
    unionCandidates(forest, 0, 1, "slug");
    expect(groupsByRoot(forest, 2)).toEqual(new Map([[0, [0, 1]]]));
    expect(tierOfRoot(forest, 0)).toBe("slug");
    expect(tierThatJoined(forest, 1)).toBe("slug");
  });

  it("keeps the strongest tier for the group and the weaker one for the node it absorbed", () => {
    // 0-1 at `slug` and 1-2 at `normalized`: the group's evidence is the strongest
    // edge, while node 2's own link is only the one that absorbed it.
    const forest = createConceptForest(3);
    unionCandidates(forest, 0, 1, "slug");
    unionCandidates(forest, 1, 2, "normalized");
    expect(tierOfRoot(forest, rootOf(forest, 2))).toBe("slug");
    expect(tierThatJoined(forest, 2)).toBe("normalized");
  });

  it("reports slug for a candidate no merge touched", () => {
    const forest = createConceptForest(1);
    expect(tierOfRoot(forest, 0)).toBe("slug");
    expect(tierThatJoined(forest, 0)).toBe("slug");
  });
});
