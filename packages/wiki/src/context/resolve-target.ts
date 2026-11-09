/**
 * @file The one resolver for a page name typed by a human.
 *
 * WHY IT IS SHARED. Every read command that accepts a page reference — `race`,
 * `links-here`, and any later one — answers the SAME question: "which node does
 * this text mean?". Two copies of that answer is two behaviours for one input,
 * which is exactly the defect this module removes: `race` had its own chain in
 * `race-path.ts` and `links-here` had another in its command module, and they
 * disagreed (one of them skipped dangling nodes, the other did not, and their
 * last-resort tie-break read a different list). There is now one chain.
 *
 * THE PRECEDENCE CHAIN, in order, first hit wins:
 *   1. EXACT id. `concepts/foo` means the node whose id is literally that.
 *   2. DEFAULT DIRECTORY. A bare `foo` means `concepts/foo` — the directory a
 *      default project writes, so the common case never needs the prefix typed.
 *   3. ANY DIRECTORY. `foo` also matches `<directory>/foo` for any other
 *      namespace (`queries/foo`), cheapest useful courtesy for a reader who
 *      forgot where a page lives.
 * Nothing else is a match: a slug PREFIX is not a match, case is significant,
 * and surrounding whitespace is not trimmed. Guessing any of those would make
 * one name resolve to different pages depending on what else the wiki happens
 * to contain, which is the opposite of navigable.
 *
 * THE TIE-BREAK. Steps 1 and 2 are unambiguous by construction. Step 3 can see
 * more than one candidate only once a wiki has three or more page directories
 * (with `concepts` and `queries` it cannot: a `concepts/` claim wins at step 2
 * and leaves at most one other namespace). When it does, candidates are visited
 * in ascending id order (UTF-16 code-unit comparison, locale-independent), so
 * the answer is the lowest matching id on every machine and every run.
 *
 * THE ELIGIBLE-NODE SCOPE. The chain is shared; WHICH nodes it may land on is
 * the caller's declared question, and that parameter is the only thing that
 * differs between the two current callers:
 *   - {@link TargetScope} `"article"` (the default): only nodes with a backing
 *     page. A dangling target has no article to stand on, so `race` must refuse
 *     it as a start, a destination, or a stop.
 *   - `"include-dangling"`: ghost nodes count too. `links-here` asks who points
 *     at a name, and "which page mentions this broken link?" is a real question
 *     about the graph — refusing it would hide the page that needs fixing.
 * `links-here` keeps its published answer this way rather than being silently
 * changed by the refactor; the scope is explicit at the call site and pinned by
 * `test/context/resolve-target.test.ts`.
 */

import { collectGhostIds } from "./graph.js";
import type { GraphData, GraphNodeId } from "../viewer/types.js";

/** Directory a bare slug is resolved against first. */
const DEFAULT_TARGET_DIRECTORY = "concepts";

/**
 * Which nodes a name is allowed to resolve to.
 *
 * `"article"` — only nodes backed by a real page (default; the wiki-race and
 * link-target question). `"include-dangling"` — ghost nodes are candidates too
 * (the "who mentions this name?" question).
 */
export type TargetScope = "article" | "include-dangling";

/**
 * Resolve a caller's page reference to a graph node id.
 *
 * @param graph - The wiki graph (as served by the viewer snapshot).
 * @param requested - Namespaced id (`concepts/foo`) or a bare slug (`foo`).
 * @param scope - Eligible nodes; `"article"` when omitted. See the file header
 *   for the chain, the tie-break, and why the two current callers differ here.
 * @returns The resolved node id, or `null` when nothing eligible matches.
 */
export function resolveTargetNodeId(
  graph: GraphData,
  requested: string,
  scope: TargetScope = "article",
): GraphNodeId | null {
  if (requested.length === 0) return null;
  const candidates = eligibleIds(graph, scope);
  const exact = candidates.find((id) => id === requested);
  if (exact !== undefined) return exact;
  const inDefaultDirectory = `${DEFAULT_TARGET_DIRECTORY}/${requested}`;
  const preferred = candidates.find((id) => id === inDefaultDirectory);
  if (preferred !== undefined) return preferred;
  return candidates.find((id) => id.endsWith(`/${requested}`)) ?? null;
}

/**
 * Node ids the scope allows, in ascending id order.
 *
 * Sorted rather than left in snapshot order so the step-3 tie-break above is a
 * property of this module instead of a property of how pages happened to be
 * collected. Sorting cannot disturb steps 1 and 2, which are equality tests.
 */
function eligibleIds(graph: GraphData, scope: TargetScope): GraphNodeId[] {
  const ghosts = scope === "article" ? collectGhostIds(graph.nodes) : null;
  return graph.nodes
    .map((node) => node.id)
    .filter((id) => ghosts === null || !ghosts.has(id))
    .sort(compareNodeIds);
}

/**
 * Ascending page-id order by UTF-16 code unit — deliberately not
 * `localeCompare`, so the tie-break is identical on every machine and locale.
 */
function compareNodeIds(left: GraphNodeId, right: GraphNodeId): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
