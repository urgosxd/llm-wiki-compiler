/**
 * @file One stated rule for "this node is not an article", shared by both readers.
 *
 * THE PROBLEM. `race` decided ghost-ness with the one predicate in `graph.ts`
 * (`node.isDangling`), while `links-here` carried a stricter private variant:
 * "flagged dangling AND no real node claims the id". Two commands answering the
 * same navigational question therefore classified the same node differently, and
 * nothing tested that. The two variants disagree on exactly one input — a graph
 * where a dangling-flagged node shares its id with a real one — which is the
 * second case below.
 *
 * WHY ONE RULE IS SAFE. The snapshot builder cannot produce that input:
 * `buildGraphData` keys ghost nodes off the page set it already has
 * (`buildGhostNodes` skips any target present in `pageIds`, and
 * `buildRelationGhostNodes` skips every `knownIds` entry), and the snapshot is
 * frozen once per read. So "flagged dangling" and "no real claim" are the same
 * predicate over every graph a command can actually see, and the extra guard in
 * `links-here` was dead defensive code rather than a second decision. The
 * builder-guarantee case pins that reasoning against a real collected wiki, so
 * the unification cannot silently become wrong later.
 *
 * The last case drives BOTH commands against the SAME dangling-page fixture.
 * Every case runs against its own throwaway wiki from `test/fixtures/temp-root.ts`
 * (created, chdir'd into, and removed by that fixture), and captures command output
 * through `test/fixtures/process-io.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { buildViewerSnapshot } from "../../packages/wiki/src/viewer/snapshot.js";
import { collectGhostIds, isGhostNode } from "../../packages/wiki/src/context/graph.js";
import { findInboundLinks } from "../../packages/wiki/src/context/links-here.js";
import { resolveTargetNodeId } from "../../packages/wiki/src/context/resolve-target.js";
import raceCommand from "../../packages/wiki/src/commands/race.js";
import linksHereCommand from "../../packages/wiki/src/commands/links-here.js";
import { ghostNode, realNode } from "../fixtures/graph-data.js";
import { useConceptPage } from "../fixtures/concept-page.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import type { GraphData, PageId } from "../../packages/wiki/src/viewer/types.js";

const DUP = "concepts/dup" as PageId;
const BETA = "concepts/beta" as PageId;

/** Throwaway wiki for the current case, plus its concept-page writer. */
const { ctx, page } = useConceptPage();

/** A graph the builder cannot emit: one id claimed by a real node AND a ghost. */
function duplicatedIdGraph(): GraphData {
  return {
    nodes: [realNode(DUP), realNode(BETA), ghostNode(DUP)],
    edges: [{ source: DUP, target: BETA }],
  };
}

describe("isGhostNode — the shared not-an-article rule", () => {
  it("flags exactly the dangling-flagged node", () => {
    expect(isGhostNode(ghostNode(DUP))).toBe(true);
    expect(isGhostNode(realNode(DUP))).toBe(false);
  });

  it("collects exactly the ids the predicate flags", () => {
    expect([...collectGhostIds(duplicatedIdGraph().nodes)]).toEqual([DUP]);
  });
});

describe("ghost classification shared by both readers", () => {
  it("treats a dangling-flagged id as a non-article even when a real node claims it", () => {
    const graph = duplicatedIdGraph();
    // Both readers must answer the same for the same node. The dangling flag
    // wins: it is the one rule, and the builder never lets the two coexist.
    expect(findInboundLinks(graph, BETA)).toEqual([]);
    expect(resolveTargetNodeId(graph, "dup", "article")).toBe(null);
  });
});

describe("the snapshot builder guarantee behind the rule", () => {
  it("emits no ghost node for an id a real page already claims", async () => {
    await page("dup", "Dup", "The page about dup.");
    await page("beta", "Beta", "See [[dup]] for more.");
    const snapshot = await buildViewerSnapshot(ctx.dir);
    const dupNodes = snapshot.graph.nodes.filter((node) => node.id === DUP);
    expect(dupNodes).toHaveLength(1);
    expect(isGhostNode(dupNodes[0]!)).toBe(false);
  });

  it("still emits a ghost for a name no page claims", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const snapshot = await buildViewerSnapshot(ctx.dir);
    expect([...collectGhostIds(snapshot.graph.nodes)]).toEqual(["concepts/nowhere"]);
  });
});

describe("both commands classify the same dangling page alike", () => {
  it("never navigates to the ghost and never lists it as a linking page", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const io = captureProcessIo();
    expect(await raceCommand("nowhere", "alpha", {})).toBe(2);
    expect(io.err()).toContain('No page named "nowhere" exists in this wiki.');
    vi.restoreAllMocks();
    const second = captureProcessIo();
    expect(await linksHereCommand("nowhere", { json: true })).toBe(0);
    const payload = JSON.parse(second.out());
    expect(payload.target).toBe("concepts/nowhere");
    expect(payload.inbound.map((entry: { pageId: string }) => entry.pageId)).toEqual(["concepts/alpha"]);
    expect(second.err()).toBe("");
  });
});
