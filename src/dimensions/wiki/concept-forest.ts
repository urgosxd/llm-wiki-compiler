/**
 * @file src/dimensions/wiki/concept-forest.ts
 * @description Union-find over concept candidates, the data structure the
 * deterministic identity resolver groups with.
 *
 * Separate from `concept-resolution.ts` because it is a self-contained
 * integer-graph structure with no notion of concepts or similarity: it only knows
 * how to join two indices and how to report which indices ended up together.
 * Keeping it apart is what lets the resolver's grouping be read as policy rather
 * than as index bookkeeping.
 *
 * It also carries the group's strongest evidence tier. Joining A-B at `slug` and
 * later B-C at `normalized` must report the group as `slug`, because the stronger
 * evidence is what justifies keeping the merge -- a lower rank is stronger,
 * matching {@link MergeTier} order.
 *
 * ## Only the name rules may join
 *
 * Similarity used to contribute two extra ranks (`auto` and `review`) to this table.
 * They are gone from the identity vocabulary, and {@link unionCandidates} refuses any
 * tier this table does not own, so a cosine score cannot reach group construction even
 * from an untyped caller or a cast. The rank table is the whole vocabulary.
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
};

/**
 * Whether `tier` names a deterministic identity rule.
 *
 * Exported because the identity module asserts the same rule where it REPORTS a
 * group's evidence: one vocabulary, checked at both boundaries, so a rank the name
 * rules do not own is refused when it enters group construction and again on the way
 * out to the caller.
 *
 * @param tier - An evidence tier, or a rank-shaped string from an untyped caller.
 * @returns True when the rank is one of the deterministic name rules.
 */
export function isDeterministicTier(tier: string): tier is MergeTier {
  return tier === "slug" || tier === "normalized";
}

/**
 * The strength rank of a tier the name rules own.
 *
 * @param tier - Evidence tier from a caller; checked, never trusted.
 * @returns The tier's {@link TIER_RANK} value.
 * @throws Error when `tier` is not a deterministic identity rule, which is the only
 *   way a similarity score could ever decide that two concepts are one.
 */
function rankOf(tier: string): number {
  if (!isDeterministicTier(tier)) {
    throw new Error(
      `"${tier}" is not a deterministic identity rule; similarity cannot decide concept identity`,
    );
  }
  return TIER_RANK[tier];
}

/** Rank recorded for a node that no merge has touched. */
const NO_MERGE_RANK = Number.POSITIVE_INFINITY;

/** Disjoint-set forest over candidate indices plus their strongest evidence. */
export interface ConceptForest {
  readonly parent: number[];
  readonly rank: number[];
  /** Strongest evidence tier seen per root, as a {@link TIER_RANK} value. */
  readonly strongest: number[];
  /**
   * Per-node evidence of the strongest merge that JOINED that node to another
   * one, as a {@link TIER_RANK} value.
   *
   * Load-bearing for alias routing. A node absorbed through a `normalized` edge does
   * not inherit the strength of an unrelated `slug` edge that joined two OTHER nodes
   * in the same group, so the alias that absorbed it is recorded with the tier that
   * really justified it.
   */
  readonly joinedBy: number[];
}

/** Fresh forest over `size` candidates, each in its own group. */
export function createConceptForest(size: number): ConceptForest {
  return {
    parent: Array.from({ length: size }, (_, index) => index),
    rank: Array.from({ length: size }, () => 0),
    strongest: Array.from({ length: size }, () => NO_MERGE_RANK),
    joinedBy: Array.from({ length: size }, () => NO_MERGE_RANK),
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
 *
 * @param forest - Forest to join in.
 * @param left - First candidate index.
 * @param right - Second candidate index.
 * @param tier - The name rule that justifies the merge.
 * @throws Error when `tier` is not a deterministic identity rule, so group
 *   construction can never be driven by a similarity score.
 */
export function unionCandidates(
  forest: ConceptForest,
  left: number,
  right: number,
  tier: MergeTier,
): void {
  const leftRoot = findRoot(forest, left);
  const rightRoot = findRoot(forest, right);
  const rank = rankOf(tier);

  if (leftRoot === rightRoot) {
    forest.strongest[leftRoot] = Math.min(forest.strongest[leftRoot], rank);
    return;
  }

  const root = forest.rank[leftRoot] < forest.rank[rightRoot] ? rightRoot : leftRoot;
  const child = root === leftRoot ? rightRoot : leftRoot;
  forest.parent[child] = root;
  // The absorbed node's OWN linkage is this edge, whichever side it came from.
  // Recorded per node so a review-band member never masquerades as confident.
  forest.joinedBy[left] = Math.min(forest.joinedBy[left], rank);
  forest.joinedBy[right] = Math.min(forest.joinedBy[right], rank);
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
 * Maps a {@link TIER_RANK} value back to its tier name.
 *
 * A rank no rule owns reports `slug`: the weakest claim available, so a group whose
 * evidence cannot be read never overstates how it was formed.
 */
function tierForRank(rank: number): MergeTier {
  const match = (Object.keys(TIER_RANK) as MergeTier[]).find(
    (tier) => TIER_RANK[tier] === rank,
  );
  return match ?? "slug";
}

/**
 * The tier a group's evidence justifies.
 *
 * A single-member group reports `slug`: nothing merged it, and `slug` is the
 * weakest claim available, so it never overstates how the group was formed.
 */
export function tierOfRoot(forest: ConceptForest, root: number): MergeTier {
  return tierForRank(forest.strongest[root]);
}

/**
 * The tier of the edge that actually absorbed ONE node into its group.
 *
 * This is the per-member truth the alias tiers must be built from. A node no merge
 * touched reports `slug`, and a node absorbed by a `normalized` edge reports
 * `normalized` even when another edge in its group is a stronger `slug` match.
 */
export function tierThatJoined(forest: ConceptForest, node: number): MergeTier {
  return tierForRank(forest.joinedBy[node]);
}
