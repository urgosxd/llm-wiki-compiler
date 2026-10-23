/**
 * @file Inbound link resolution — "which pages point at this one?".
 *
 * The compiled wiki records only the OUTBOUND direction: each page stores the
 * links it casts (`outgoingLinks`), so walking A → B works and B → A is
 * invisible. Recovering the reverse direction means scanning every page, which
 * is why it gets one pure function here instead of being inlined at each call
 * site.
 *
 * This reads the same `GraphData` the viewer serves, so a reader and an agent
 * can never disagree about who links to what. `src/context/graph.ts` already
 * builds this inverse internally for neighborhood expansion; this module is the
 * version that can be asked the question directly.
 *
 * Three rules are inherited deliberately, not invented here:
 *   - Ghost (dangling) targets are excluded, matching `collectGhostIds`.
 *   - A bidirectional pair (A→B and B→A) collapses to ONE entry, matching the
 *     canonical unordered-pair rule documented in `graph.ts`.
 *   - Output is deterministic: sorted by node id, so a diff of two runs is empty.
 */

import type { GraphData, GraphNodeId } from "../viewer/types.js";

/** One page that links to the requested target. */
export interface InboundLink {
  /** The linking page's node id (e.g. `concepts/change-detection`). */
  from: GraphNodeId;
  /**
   * True when the pair is ALSO linked in the other direction (the target links
   * back). A reader can treat this as "mutual" without a second lookup.
   */
  mutual: boolean;
}

/**
 * Resolve every page that links to `targetId`.
 *
 * Inbound edges come from `graph.edges`, so this works for wikilink and typed
 * relation edges alike — a relation edge is just another `source`→`target`
 * pair, exactly as `buildAdjacency` treats it.
 *
 * @param graph - The wiki graph (as served by the viewer snapshot).
 * @param targetId - The node id to find inbound links for.
 * @returns Inbound pages, sorted by id, one entry per distinct linking page.
 * Frozen contract v1: consumed by orchestrator-c; keep this signature stable.
 */
export function findInboundLinks(
  graph: GraphData,
  targetId: GraphNodeId,
): InboundLink[] {
  const ghostIds = collectGhostIds(graph);
  const targetsOf = buildOutgoingIndex(graph);
  const inbound = new Map<GraphNodeId, true>();

  for (const edge of graph.edges) {
    if (edge.target !== targetId) continue;
    // A ghost source is not a real page; it cannot be navigated to.
    if (ghostIds.has(edge.source)) continue;
    inbound.set(edge.source, true);
  }

  // Mutual means the pair is linked BOTH ways: this source points here AND the
  // target points back. Checking the source's own out-edge would make every
  // inbound link look mutual, since by definition it already points here.
  const targetOutgoing = targetsOf.get(targetId);
  const links: InboundLink[] = [];
  for (const from of inbound.keys()) {
    links.push({ from, mutual: targetOutgoing?.has(from) === true });
  }
  return links.sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
}

/** Index outgoing edge targets per source, including relation edges. */
function buildOutgoingIndex(graph: GraphData): Map<GraphNodeId, Set<GraphNodeId>> {
  const outgoing = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const edge of graph.edges) {
    const existing = outgoing.get(edge.source);
    if (existing) existing.add(edge.target);
    else outgoing.set(edge.source, new Set([edge.target]));
  }
  return outgoing;
}

/**
 * Collect node ids that exist only as an unresolved link target.
 *
 * An id counts as a ghost only when it is flagged `isDangling` AND no real node
 * claims it, so a page created after the graph was built is never hidden from
 * the inbound list.
 */
function collectGhostIds(graph: GraphData): Set<GraphNodeId> {
  const real = new Set<GraphNodeId>();
  const dangling = new Set<GraphNodeId>();
  for (const node of graph.nodes) {
    if (node.isDangling === true) dangling.add(node.id);
    else real.add(node.id);
  }
  for (const id of real) dangling.delete(id);
  return dangling;
}
