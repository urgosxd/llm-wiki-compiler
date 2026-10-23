/**
 * @file src/dimensions/wiki/concept-forest.ts
 * @description Union-find over concept candidates, the data structure the
 * two-threshold resolver groups with.
 *
 * Separate from `concept-resolution.ts` because it is a self-contained
 * integer-graph structure with no notion of concepts, similarity or thresholds: it
 * only knows how to join two indices and how to report which indices ended up
 * together. Keeping it apart is what lets the resolver's grouping be read as
 * policy rather than as index bookkeeping.
 *
 * It also carries the group's strongest evidence tier. Joining A-B at the
 * deterministic tier and later B-C at the review band must report the group as
 * deterministic, because the stronger evidence is what justifies keeping the
 * merge — a lower rank is stronger, matching {@link MergeTier} order.
 */

import type { MergeTier } from "./concept-resolution.js";

/**
 * Strength order for merge evidence; a LOWER rank is stronger evidence.
 *
 * Internal on purpose: the rank is a representation detail of this module. Callers
 * ask {@link tierOfRoot} for a tier and never compare ranks themselves.
 */
const TIER_RANK: Readonly<Record<MergeTier, number>> = {
  slug: 0,
  normalized: 1,
  auto: 2,
  review: 3,
};

/** Rank recorded for a node that no merge has touched. */
const NO_MERGE_RANK = Number.POSITIVE_INFINITY;

/** Disjoint-set forest over candidate indices plus their strongest evidence. */
export interface ConceptForest {
  readonly parent: number[];
  readonly rank: number[];
  /** Strongest evidence tier seen per root, as a {@link TIER_RANK} value. */
  readonly strongest: number[];
}

/** Fresh forest over `size` candidates, each in its own group. */
export function createConceptForest(size: number): ConceptForest {
  return {
    parent: Array.from({ length: size }, (_, index) => index),
    rank: Array.from({ length: size }, () => 0),
    strongest: Array.from({ length: size }, () => NO_MERGE_RANK),
  };
}

/** Root of `node`, with path compression so repeated lookups stay cheap. */
function findRoot(forest: ConceptForest, node: number): number {
  let root = node;
  while (forest.parent[root] !== root) {
    root = forest.parent[root];
  }
  let cursor = node;
  while (forest.parent[cursor] !== root) {
    const next = forest.parent[cursor];
    forest.parent[cursor] = root;
    cursor = next;
  }
  return root;
}

/**
 * Joins two candidates and records `tier` as evidence for the resulting group.
 *
 * Re-joining members of one group does not create a cycle; it only strengthens
 * that group's evidence.
 */
export function unionCandidates(
  forest: ConceptForest,
  left: number,
  right: number,
  tier: MergeTier,
): void {
  const leftRoot = findRoot(forest, left);
  const rightRoot = findRoot(forest, right);
  const rank = TIER_RANK[tier];

  if (leftRoot === rightRoot) {
    forest.strongest[leftRoot] = Math.min(forest.strongest[leftRoot], rank);
    return;
  }

  const root = forest.rank[leftRoot] < forest.rank[rightRoot] ? rightRoot : leftRoot;
  const child = root === leftRoot ? rightRoot : leftRoot;
  forest.parent[child] = root;
  if (forest.rank[root] === forest.rank[child]) {
    forest.rank[root] += 1;
  }
  forest.strongest[root] = Math.min(
    forest.strongest[leftRoot],
    forest.strongest[rightRoot],
    rank,
  );
}

/** Groups candidate indices by their resolved root, preserving input index order. */
export function groupsByRoot(
  forest: ConceptForest,
  size: number,
): Map<number, number[]> {
  const byRoot = new Map<number, number[]>();
  for (let index = 0; index < size; index += 1) {
    const root = findRoot(forest, index);
    const members = byRoot.get(root);
    if (members === undefined) {
      byRoot.set(root, [index]);
      continue;
    }
    members.push(index);
  }
  return byRoot;
}

/**
 * The tier a group's evidence justifies.
 *
 * A single-member group reports `slug`: nothing merged it, and `slug` is the
 * weakest claim available, so it never overstates how the group was formed.
 */
export function tierOfRoot(forest: ConceptForest, root: number): MergeTier {
  const rank = forest.strongest[root];
  if (rank === NO_MERGE_RANK) {
    return "slug";
  }
  const match = (Object.keys(TIER_RANK) as MergeTier[]).find(
    (tier) => TIER_RANK[tier] === rank,
  );
  return match ?? "review";
}
