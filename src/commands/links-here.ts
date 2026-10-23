/**
 * @file `llmwiki links-here <slug>` — walk the wiki backwards.
 *
 * Every page records the links it casts, so the compiler can answer "where can
 * I go from A?" but not "what points at B?". This command answers the second
 * question, which is what makes the wiki navigable as a graph rather than a set
 * of one-way streets: from a concept you can find the concepts that reference
 * it and continue from there.
 *
 * READ-ONLY and provider-free. It reads the same graph the viewer serves
 * (`buildViewerSnapshot`) so a reader and an agent can never disagree about who
 * links to what. Nothing is written, no lock is taken, and no LLM is called.
 *
 * A page with no inbound links is a normal answer, not an error: a freshly
 * compiled leaf concept legitimately has none yet. The exit code stays 0 and the
 * envelope reports an empty list, so a caller can distinguish "orphan" from
 * "command failed" without parsing prose.
 */

import { buildViewerSnapshot } from "../viewer/snapshot.js";
import { findInboundLinks, type InboundLink } from "../context/links-here.js";
import type { GraphData, GraphNodeId } from "../viewer/types.js";

/** Versioned JSON envelope, incremented independently of other commands. */
const LINKS_HERE_JSON_VERSION = 1;

/** CLI options for `llmwiki links-here`. */
export interface LinksHereOptions {
  /** Emit the stable JSON envelope instead of the human list. */
  json?: boolean;
}

/** One inbound reference as reported to the caller. */
interface ReportedLink {
  pageId: GraphNodeId;
  title: string;
  mutual: boolean;
}

/**
 * Resolve the caller's argument to a graph node id.
 *
 * Accepts the namespaced form (`concepts/foo`) and a bare slug (`foo`), because
 * typing the directory prefix is bookkeeping a reader should not have to do.
 * A bare slug prefers `concepts/` — the default kind and the only directory a
 * default project writes — then falls back to any other namespace that matches.
 */
function resolveTargetId(graph: GraphData, requested: string): GraphNodeId | null {
  const ids = graph.nodes.map((node) => node.id);
  if (ids.includes(requested as GraphNodeId)) return requested as GraphNodeId;
  const conceptId = `concepts/${requested}` as GraphNodeId;
  if (ids.includes(conceptId)) return conceptId;
  const match = ids.find((id) => id.endsWith(`/${requested}`));
  return match ?? null;
}

/** Attach the human title for each inbound page, falling back to the page id. */
function withTitles(graph: GraphData, links: InboundLink[]): ReportedLink[] {
  const titles = new Map<GraphNodeId, string>();
  for (const node of graph.nodes) titles.set(node.id, node.title);
  return links.map((link) => ({
    pageId: link.from,
    title: titles.get(link.from) ?? link.from,
    mutual: link.mutual,
  }));
}

/** Render the human-readable list. */
function renderHuman(targetId: GraphNodeId, links: ReportedLink[]): string {
  if (links.length === 0) {
    return `No pages link to ${targetId}.\n` +
      `Nothing is broken: an inbound link appears once another page mentions this one.`;
  }
  const lines = [`${links.length} page(s) link to ${targetId}:`, ""];
  for (const link of links) {
    const marker = link.mutual ? " (mutual)" : "";
    lines.push(`  [[${link.pageId}]] ${link.title}${marker}`);
  }
  lines.push("", "Follow any of these page ids with `llmwiki links-here` to keep walking.");
  return lines.join("\n");
}

/** Build the stable JSON envelope for agent consumption. */
function buildJsonPayload(targetId: GraphNodeId | null, requested: string, links: ReportedLink[]) {
  return {
    version: LINKS_HERE_JSON_VERSION,
    target: targetId,
    requested,
    resolved: targetId !== null,
    inboundCount: links.length,
    inbound: links,
  };
}

/**
 * Run `llmwiki links-here <slug>`.
 * @param slug - Namespaced page id (`concepts/foo`) or a bare slug (`foo`).
 * @param options - `--json` switches to the stable envelope.
 * @returns Process exit code; always 0 for a successful inspection.
 */
export default async function linksHereCommand(
  slug: string,
  options: LinksHereOptions = {},
): Promise<number> {
  const root = process.cwd();
  const snapshot = await buildViewerSnapshot(root);
  const graph = snapshot.graph;
  const targetId = resolveTargetId(graph, slug);
  const links = targetId === null ? [] : withTitles(graph, findInboundLinks(graph, targetId));

  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildJsonPayload(targetId, slug, links), null, 2)}\n`);
  } else if (targetId === null) {
    process.stdout.write(`No page named "${slug}" exists in this wiki.\n`);
  } else {
    process.stdout.write(`${renderHuman(targetId, links)}\n`);
  }
  return 0;
}
