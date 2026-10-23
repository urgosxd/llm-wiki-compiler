/**
 * @file Graph fixtures shared by the graph-reading test suites.
 *
 * `context-graph` and `context-links-here` both need synthetic `GraphData`:
 * real nodes, dangling (ghost) nodes, and directed edges. Building that shape
 * twice meant two definitions of "what a ghost node is" that could drift, so it
 * lives here once.
 */

import type { GraphData, GraphNode, PageId } from "../../src/viewer/types.js";

/** Build a real (navigable) graph node for `id`. */
export function realNode(id: PageId): GraphNode {
  const slug = id.split("/")[1] ?? id;
  return { id, title: slug, slug, directory: "concepts", kind: "concept", degree: 0 };
}

/** Build a dangling target node — a link with no backing page. */
export function ghostNode(id: PageId): GraphNode {
  const slug = id.split("/")[1] ?? id;
  return {
    id,
    title: slug,
    slug,
    directory: "concepts",
    kind: "dangling",
    degree: 0,
    isDangling: true,
  };
}

/** Compose synthetic `GraphData` from real ids, directed edges, and ghosts. */
export function syntheticGraph(spec: {
  realIds: PageId[];
  edges: [PageId, PageId][];
  ghostIds?: PageId[];
}): GraphData {
  return {
    nodes: [
      ...spec.realIds.map(realNode),
      ...(spec.ghostIds ?? []).map(ghostNode),
    ],
    edges: spec.edges.map(([source, target]) => ({ source, target })),
  };
}
