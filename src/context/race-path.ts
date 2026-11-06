/**
 * @file Wiki-race path finding over the compiled link graph.
 *
 * THE MECHANIC. A wiki race is the game of reaching page B from page A using
 * only the links that already exist inside the articles. The compiler already
 * builds that graph once per read (`buildViewerSnapshot`), so this module is a
 * pure reader over it: no second graph model, no storage, no writes, no LLM.
 *
 * WHY IT IS A SEPARATE MODULE. `src/context/graph.ts` answers "what is around
 * this page?" (neighbourhood expansion, both directions). A race asks a
 * different question — "is there a ROUTE, and which one?" — and the difference
 * is not cosmetic: a race follows outgoing links only, must return ONE route
 * when several shortest ones tie, and must say when the depth bound is what
 * stopped it. Those three rules are the whole contract and they are pinned here.
 *
 * The adjacency, the edge reading and the ghost rule are imported from
 * `graph.ts` rather than re-implemented, so a race and a context pack can never
 * disagree about what an edge is or which node is an article.
 *
 * Determinism: the walk is breadth-first, the frontier keeps discovery order,
 * and every node's successors are visited in ascending page-id order (plain
 * code-unit comparison, which is locale-independent). The first discovery of a
 * target therefore yields the lexicographically smallest of the equally short
 * routes, and no part of the answer depends on filesystem or object-key order.
 */

import { buildAdjacency, collectGhostIds } from "./graph.js";
import type { GraphData, GraphNodeId } from "../viewer/types.js";

/**
 * Default number of hops a race search may walk before it stops.
 *
 * NAMED ON PURPOSE (S12: no silent limits). The bound is reported in every
 * result and in the `--json` envelope, and the human output names it, so a
 * caller always knows whether "no route" means "nowhere to go" or "far away".
 */
export const DEFAULT_RACE_MAX_DEPTH = 6;

/**
 * Hard ceiling on `--max-depth`. A larger request is clamped, and the clamp is
 * reported as the effective `maxDepth` next to the `requestedMaxDepth` value, so
 * the caller can see that the bound was reduced rather than silently obeyed.
 */
export const RACE_MAX_DEPTH_CEILING = 20;

/** Why a completed search produced no route. Never a bare "not found". */
export type RaceFailureReason = "no-path" | "depth-bound";

/** Empty successor set reused for pages with no outgoing links. */
const NO_SUCCESSORS: ReadonlySet<GraphNodeId> = new Set<GraphNodeId>();

/** Inputs of one race query. Endpoints are already-resolved graph node ids. */
export interface RacePathQuery {
  from: GraphNodeId;
  to: GraphNodeId;
  /** Hop budget; omitted means {@link DEFAULT_RACE_MAX_DEPTH}. */
  maxDepth?: number;
}

/** Outcome of one race query, shaped for both the human and JSON surfaces. */
export interface RacePathResult {
  from: GraphNodeId;
  to: GraphNodeId;
  found: boolean;
  /** Ordered route including both endpoints; empty when `found` is false. */
  route: GraphNodeId[];
  /** Number of links followed: `route.length - 1`, and 0 when not found. */
  hops: number;
  /** Effective hop budget actually used (after defaulting and clamping). */
  maxDepth: number;
  /** True only when the depth bound, not the graph, ended an unsuccessful search. */
  depthBoundReached: boolean;
  reason: RaceFailureReason | null;
}

/**
 * Resolve the caller's hop budget, clamping it into the named ceiling.
 *
 * @param raw - Requested depth, or `undefined` for the default.
 * @returns A non-negative integer no greater than {@link RACE_MAX_DEPTH_CEILING}.
 * @throws RangeError when the request is negative, fractional or not a number.
 */
export function resolveRaceMaxDepth(raw?: number): number {
  if (raw === undefined) return DEFAULT_RACE_MAX_DEPTH;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new RangeError(`--max-depth must be a non-negative integer (got ${raw}).`);
  }
  return Math.min(raw, RACE_MAX_DEPTH_CEILING);
}

/**
 * Resolve a caller's argument to a REAL page node id.
 *
 * Accepts the namespaced form (`concepts/foo`) and a bare slug (`foo`), exactly
 * like `links-here`. Ghost nodes are never returned: a dangling target has no
 * article to stand on, so it is not a destination and not a stop. On a bare-slug
 * tie the lowest id wins, so the answer never depends on discovery order.
 *
 * @param graph - The wiki graph.
 * @param requested - Namespaced id or bare slug.
 * @returns The resolved real node id, or `null` when nothing matches.
 */
export function resolveRaceEndpoint(graph: GraphData, requested: string): GraphNodeId | null {
  const ghosts = collectGhostIds(graph.nodes);
  const realIds = graph.nodes
    .map((node) => node.id)
    .filter((id) => !ghosts.has(id))
    .sort(compareNodeIds);
  const exact = realIds.find((id) => id === requested);
  if (exact !== undefined) return exact;
  const namespaced = `concepts/${requested}`;
  const asConcept = realIds.find((id) => id === namespaced);
  if (asConcept !== undefined) return asConcept;
  return realIds.find((id) => id.endsWith(`/${requested}`)) ?? null;
}

/**
 * Find the deterministic shortest route from one page to another.
 *
 * @param graph - The wiki graph (as served by the viewer snapshot).
 * @param query - Resolved endpoints plus the optional hop budget.
 * @returns The route, its hop count, and — when there is none — the reason.
 */
export function findRacePath(graph: GraphData, query: RacePathQuery): RacePathResult {
  const maxDepth = resolveRaceMaxDepth(query.maxDepth);
  const base = { from: query.from, to: query.to, maxDepth };
  if (query.from === query.to) {
    return { ...base, found: true, route: [query.from], hops: 0, depthBoundReached: false, reason: null };
  }
  const search = searchLevels({ graph, from: query.from, to: query.to, maxDepth });
  if (search.route !== null) {
    return {
      ...base,
      found: true,
      route: search.route,
      hops: search.route.length - 1,
      depthBoundReached: false,
      reason: null,
    };
  }
  return {
    ...base,
    found: false,
    route: [],
    hops: 0,
    depthBoundReached: search.truncated,
    reason: search.truncated ? "depth-bound" : "no-path",
  };
}

/** Raw outcome of the breadth-first walk, before it is shaped into a result. */
interface LevelSearchOutcome {
  route: GraphNodeId[] | null;
  /** True when the frontier at the bound still had unvisited successors. */
  truncated: boolean;
}

/** Grouped inputs for {@link searchLevels}. */
interface LevelSearchInput {
  graph: GraphData;
  from: GraphNodeId;
  to: GraphNodeId;
  maxDepth: number;
}

/**
 * Walk the outgoing link graph level by level until the target appears or the
 * hop budget runs out. Level order plus ascending successor ids are what make
 * the returned route the deterministic winner among equally short ones.
 */
function searchLevels(input: LevelSearchInput): LevelSearchOutcome {
  const { outgoing } = buildAdjacency(input.graph);
  const ghosts = collectGhostIds(input.graph.nodes);
  const parents = new Map<GraphNodeId, GraphNodeId | null>([[input.from, null]]);
  let frontier: GraphNodeId[] = [input.from];
  for (let depth = 1; depth <= input.maxDepth && frontier.length > 0; depth += 1) {
    const level = { to: input.to, outgoing, ghosts, parents, next: [] as GraphNodeId[] };
    for (const node of frontier) {
      const route = expandNode({ ...level, node });
      if (route !== null) return { route, truncated: false };
    }
    frontier = level.next;
  }
  return { route: null, truncated: hasUnexploredSuccessor(frontier, { outgoing, ghosts, parents }) };
}

/** Inputs for one node's successor expansion. */
interface NodeExpansionInput {
  node: GraphNodeId;
  to: GraphNodeId;
  outgoing: ReadonlyMap<GraphNodeId, Set<GraphNodeId>>;
  ghosts: ReadonlySet<GraphNodeId>;
  parents: Map<GraphNodeId, GraphNodeId | null>;
  next: GraphNodeId[];
}

/**
 * Visit one node's successors in ascending id order, record their parent, and
 * return the route when the target is among them. Ghosts and already-visited
 * nodes are skipped: a dangling target is not a stop, and a revisit cannot
 * produce a shorter route.
 */
function expandNode(input: NodeExpansionInput): GraphNodeId[] | null {
  for (const successor of sortedSuccessors(input.outgoing, input.node)) {
    if (input.ghosts.has(successor) || input.parents.has(successor)) continue;
    input.parents.set(successor, input.node);
    if (successor === input.to) return reconstructRoute(input.parents, successor);
    input.next.push(successor);
  }
  return null;
}

/** Successors of `node` as a freshly sorted array (never the stored set). */
function sortedSuccessors(
  outgoing: ReadonlyMap<GraphNodeId, Set<GraphNodeId>>,
  node: GraphNodeId,
): GraphNodeId[] {
  const successors = outgoing.get(node) ?? NO_SUCCESSORS;
  return [...successors].sort(compareNodeIds);
}

/**
 * Ascending page-id order by UTF-16 code unit.
 *
 * Deliberately not `localeCompare`: the tie-break must be identical on every
 * machine and locale, and the ids are ASCII slugs, so a plain comparison is both
 * stable and cheaper.
 */
function compareNodeIds(left: GraphNodeId, right: GraphNodeId): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Walk the parent chain back from `target` into a start-to-target route. */
function reconstructRoute(
  parents: ReadonlyMap<GraphNodeId, GraphNodeId | null>,
  target: GraphNodeId,
): GraphNodeId[] {
  const route: GraphNodeId[] = [];
  let current: GraphNodeId | null = target;
  while (current !== null) {
    route.push(current);
    current = parents.get(current) ?? null;
  }
  return route.reverse();
}

/** Inputs for the truncation check. */
interface TruncationInput {
  outgoing: ReadonlyMap<GraphNodeId, Set<GraphNodeId>>;
  ghosts: ReadonlySet<GraphNodeId>;
  parents: ReadonlyMap<GraphNodeId, GraphNodeId | null>;
}

/**
 * True when the walk stopped with work left: some node at the bound still has a
 * successor that is neither a ghost nor already visited. That is the difference
 * between "the destination is far away" and "there is no such route", and it is
 * what keeps the depth bound from being a silent limit.
 */
function hasUnexploredSuccessor(
  frontier: readonly GraphNodeId[],
  input: TruncationInput,
): boolean {
  for (const node of frontier) {
    for (const successor of input.outgoing.get(node) ?? NO_SUCCESSORS) {
      if (!input.ghosts.has(successor) && !input.parents.has(successor)) return true;
    }
  }
  return false;
}
