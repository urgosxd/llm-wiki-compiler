/**
 * @file Graph health — is the compiled link graph NAVIGABLE, or merely decorative?
 *
 * ## The question this answers
 *
 * Stages 4 and 5 exist to connect concepts: contextual links, and the review that adds a
 * reference from an earlier page to a new article. Whether they produced a graph a reader
 * can WALK is a separate question from whether links exist, and nothing measured it. This
 * module does, over the graph the compiler already builds — no second graph model, no
 * storage, no writes, no LLM.
 *
 * ## What a pair means, and what depth means
 *
 * A PAIR is an ordered pair `(from, to)` of distinct ARTICLE nodes in
 * `buildViewerSnapshot`'s graph: real pages, ghosts excluded by the ONE not-an-article
 * predicate (`isGhostNode` in `context/graph.ts`). Ordering matters because links are
 * directional — `A → B` says nothing about `B → A`, and a wiki whose links only run one
 * way is not navigable in the other.
 *
 * DEPTH is the number of links followed by the shortest route from `from` to `to`,
 * computed by the SAME breadth-first traversal `llmwiki race` uses (`findRacePath` in
 * `context/race-path.ts`), so a measurement and a playable race can never disagree about
 * what a route is. A pair with no route within the traversal bound is counted
 * UNREACHABLE, and the bound is printed with the count.
 *
 * ## Why the distribution AND the unreachable count
 *
 * A single "average hops" figure can be moved by over-linking one hub, so on its own it
 * cannot say whether the graph is navigable. Depth distribution plus the count of ordered
 * pairs with no route can be gamed only by making the graph genuinely more connected —
 * which is the point. Neither number is invented as "correct": a small wiki is legitimately
 * shallow and one long chain is legitimately deep.
 *
 * ## Bounded, explicit, deterministic
 *
 * Pairs are visited in a deterministic order (article ids ascending, then the pair list in
 * that order) and capped by {@link MAX_GRAPH_HEALTH_PAIRS}, with the cap, the total pair
 * count and the number of pairs actually walked all present in the report. Two runs over
 * the same graph therefore produce byte-identical output, independent of filesystem order,
 * object-key order or edge order.
 */

import { isGhostNode } from "./graph.js";
import { RACE_MAX_DEPTH_CEILING, findRacePath } from "./race-path.js";
import { GRAPH_HEALTH_FLAT_DEPTH, MAX_GRAPH_HEALTH_PAIRS } from "../utils/constants.js";
import type { GraphData, GraphNodeId } from "../viewer/types.js";

/** Pairs walked when the caller asks for no particular cap. */
export const DEFAULT_GRAPH_HEALTH_PAIR_CAP = MAX_GRAPH_HEALTH_PAIRS;

/** Hop bound each pair's route search uses, i.e. the race traversal's own ceiling. */
const GRAPH_HEALTH_MAX_DEPTH = RACE_MAX_DEPTH_CEILING;

/** Inputs of one measurement. */
export interface GraphHealthQuery {
  /** Sampled-pair cap; omitted means {@link DEFAULT_GRAPH_HEALTH_PAIR_CAP}. */
  pairCap?: number | string;
}

/** How many sampled pairs resolved in exactly `depth` hops. */
export interface GraphDepthBucket {
  readonly depth: number;
  readonly pairs: number;
}

/** One measurement, shaped for both the human and the JSON surface. */
export interface GraphHealthReport {
  /** Article nodes the pairs were drawn from (ghosts excluded). */
  readonly pages: number;
  /** The sampled-pair cap this run used. */
  readonly pairCap: number;
  /** Every ordered pair of distinct articles, `pages * (pages - 1)`. */
  readonly totalPairs: number;
  /** Pairs actually walked; equal to {@link totalPairs} unless the cap cut the sample. */
  readonly consideredPairs: number;
  /** True when the cap, not the pair set, ended the measurement. */
  readonly truncated: boolean;
  /** Hop bound used by each route search; unreachable means "within this bound". */
  readonly maxDepth: number;
  readonly reachablePairs: number;
  readonly unreachablePairs: number;
  /** Hops of the longest reachable route in the sample, or null when none was reachable. */
  readonly deepestReachable: number | null;
  /** Mean hops over the reachable sample, rounded to two decimals, or null. */
  readonly meanDepth: number | null;
  /** Depth histogram, ascending by depth. */
  readonly depthHistogram: readonly GraphDepthBucket[];
  /**
   * A warning-worthy observation about the SHAPE of the sample, or null.
   *
   * Present only for the shape that must not pass silently: every reachable pair resolves
   * in {@link GRAPH_HEALTH_FLAT_DEPTH} hops or fewer. It states the fact and points at the
   * numbers; it does not invent a target distribution.
   */
  readonly observation: string | null;
}

/** Non-negative-integer check shared by the CLI flag and the query object. */
const NON_NEGATIVE_INTEGER = /^\d+$/;

/**
 * Resolve the sampled-pair cap, refusing anything that is not a non-negative integer.
 *
 * A `--pairs` value the caller cannot mean is a usage error rather than a silent clamp:
 * clamping would make a measurement claim to be bounded by a number nobody asked for, and
 * the whole point of the cap travelling in the output is that the caller can trust it.
 *
 * @param raw - Requested cap, as the CLI hands it over (a string), or `undefined`.
 * @returns The cap to use.
 * @throws RangeError when the request is negative, fractional or not a number.
 */
export function resolveGraphHealthPairCap(raw?: number | string): number {
  if (raw === undefined) return DEFAULT_GRAPH_HEALTH_PAIR_CAP;
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!NON_NEGATIVE_INTEGER.test(text)) {
    throw new RangeError(`--pairs must be a non-negative integer (got ${raw}).`);
  }
  return Number(text);
}

/** Ascending page-id order by UTF-16 code unit, independent of locale. */
function compareNodeIds(left: GraphNodeId, right: GraphNodeId): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Every article node id, in the deterministic pair order's base sequence. */
function articleIds(graph: GraphData): GraphNodeId[] {
  return graph.nodes
    .filter((node) => !isGhostNode(node))
    .map((node) => node.id)
    .sort(compareNodeIds);
}

/**
 * Walk the ordered pair set in a fixed order, stopping at the cap.
 *
 * Lazy on purpose: materialising `pages * (pages - 1)` tuples would cost more memory than
 * the measurement itself on a large wiki, and the cap means the tail is never visited.
 *
 * @param ids - Article ids, already sorted.
 * @param limit - Maximum pairs to yield.
 * @yields Ordered pairs `(from, to)` with `from !== to`.
 */
function* sampledPairs(
  ids: readonly GraphNodeId[],
  limit: number,
): Generator<readonly [GraphNodeId, GraphNodeId]> {
  let yielded = 0;
  for (const from of ids) {
    for (const to of ids) {
      if (from === to) continue;
      if (yielded >= limit) return;
      yielded += 1;
      yield [from, to] as const;
    }
  }
}

/** Running totals while the sample is walked. */
interface SampleTally {
  reachable: number;
  unreachable: number;
  sumHops: number;
  deepest: number | null;
  histogram: Map<number, number>;
}

/** One measurement accumulated in place, so the walker stays a single loop. */
function emptyTally(): SampleTally {
  return { reachable: 0, unreachable: 0, sumHops: 0, deepest: null, histogram: new Map() };
}

/** Fold one traversed pair into the tally. */
function recordPair(tally: SampleTally, hops: number | null): void {
  if (hops === null) {
    tally.unreachable += 1;
    return;
  }
  tally.reachable += 1;
  tally.sumHops += hops;
  tally.histogram.set(hops, (tally.histogram.get(hops) ?? 0) + 1);
  tally.deepest = tally.deepest === null ? hops : Math.max(tally.deepest, hops);
}

/** Histogram as an ascending, array-shaped list so the JSON is stable. */
function toHistogram(histogram: ReadonlyMap<number, number>): GraphDepthBucket[] {
  return [...histogram.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([depth, pairs]) => ({ depth, pairs }));
}

/** The observation for a shallow sample, or null when the sample is not shallow. */
function describeShape(
  deepest: number | null,
  reachable: number,
): string | null {
  if (reachable === 0 || deepest === null || deepest > GRAPH_HEALTH_FLAT_DEPTH) return null;
  return `Observation: every sampled reachable pair resolves in ${deepest} hop(s) or fewer, ` +
    "so the sampled graph is shallow — read the histogram and the unreachable count " +
    "together before treating its connectivity as healthy.";
}

/**
 * Measure the graph: depth distribution over ordered article pairs, plus the count with no
 * route at all.
 *
 * Each pair is asked of {@link findRacePath} — the same traversal `llmwiki race` plays —
 * so "reachable" here means exactly "reachable by the game's rules", and a ghost is never a
 * target (the traversal refuses it, and the pair set never contains one).
 *
 * @param graph - The wiki graph (as served by the viewer snapshot).
 * @param query - Optional sampled-pair cap.
 * @returns The measurement, with its cap and traversal bound stated.
 */
export function analyzeGraphHealth(
  graph: GraphData,
  query: GraphHealthQuery = {},
): GraphHealthReport {
  const pairCap = resolveGraphHealthPairCap(query.pairCap);
  const ids = articleIds(graph);
  // `Math.max(0, ...)` because an empty article set would otherwise yield `-0`.
  const totalPairs = Math.max(0, ids.length * (ids.length - 1));
  const tally = emptyTally();
  let consideredPairs = 0;
  for (const [from, to] of sampledPairs(ids, pairCap)) {
    consideredPairs += 1;
    const route = findRacePath(graph, { from, to, maxDepth: GRAPH_HEALTH_MAX_DEPTH });
    recordPair(tally, route.found ? route.hops : null);
  }
  return {
    pages: ids.length,
    pairCap,
    totalPairs,
    consideredPairs,
    truncated: consideredPairs < totalPairs,
    maxDepth: GRAPH_HEALTH_MAX_DEPTH,
    reachablePairs: tally.reachable,
    unreachablePairs: tally.unreachable,
    deepestReachable: tally.deepest,
    meanDepth: tally.reachable === 0 ? null : Math.round((tally.sumHops / tally.reachable) * 100) / 100,
    depthHistogram: toHistogram(tally.histogram),
    observation: describeShape(tally.deepest, tally.reachable),
  };
}

/**
 * Render the measurement for a human reader.
 *
 * Every number the report carries is printed — the sample size, the cap, the traversal
 * bound, both pair counts, the mean, the deepest route and the histogram — because a
 * measurement that hides its own bounds cannot be compared before and after a change.
 *
 * @param report - The measurement.
 * @returns The text to print, without a trailing newline.
 */
export function describeGraphHealth(report: GraphHealthReport): string {
  if (report.pages === 0) {
    return "Graph health: this wiki stores no pages yet.\n" +
      "Nothing is broken: pages appear as you compile sources.";
  }
  const sampled = report.truncated
    ? `${report.totalPairs} ordered pair(s), ${report.consideredPairs} considered ` +
      `(pair cap ${report.pairCap}, ${report.totalPairs - report.consideredPairs} not sampled)`
    : `${report.totalPairs} ordered pair(s), ${report.consideredPairs} considered ` +
      `(pair cap ${report.pairCap}, complete)`;
  const lines = [
    `Graph health for ${report.pages} page(s):`,
    "",
    `  ${sampled}.`,
    `  ${report.reachablePairs} reachable, ${report.unreachablePairs} unreachable within ` +
      `${report.maxDepth} hop(s).`,
    `  Mean shortest-path depth ${report.meanDepth ?? "n/a"} hop(s); ` +
      `deepest reachable ${report.deepestReachable ?? "n/a"}.`,
    "",
    "  Shortest-path depth distribution:",
  ];
  if (report.depthHistogram.length === 0) lines.push("    no reachable pair in the sample");
  for (const bucket of report.depthHistogram) {
    lines.push(`    ${bucket.depth} hop(s) — ${bucket.pairs} pair(s)`);
  }
  if (report.observation !== null) lines.push("", `  ${report.observation}`);
  return lines.join("\n");
}
