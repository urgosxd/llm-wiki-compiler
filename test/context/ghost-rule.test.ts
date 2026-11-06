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
 * Every case builds its own throwaway wiki under `os.tmpdir()` and removes it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { collectGhostIds, isGhostNode } from "../../src/context/graph.js";
import { findInboundLinks } from "../../src/context/links-here.js";
import { resolveTargetNodeId } from "../../src/context/resolve-target.js";
import raceCommand from "../../src/commands/race.js";
import linksHereCommand from "../../src/commands/links-here.js";
import { ghostNode, realNode } from "../fixtures/graph-data.js";
import { writePage } from "../fixtures/write-page.js";
import type { GraphData, PageId } from "../../src/viewer/types.js";

const DUP = "concepts/dup" as PageId;
const BETA = "concepts/beta" as PageId;

/** Root of the throwaway wiki for the current case. */
let root = "";
/** Directory the process started in, restored after every case. */
let origin = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ghost-rule-")));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  origin = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(origin);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write one concept page into the throwaway wiki. */
async function page(slug: string, title: string, body: string): Promise<void> {
  await writePage(path.join(root, "wiki/concepts"), slug, { title }, body);
}

/** Capture everything a command writes to stdout and stderr. */
function captureIo(): { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return { out: () => out.join(""), err: () => err.join("") };
}

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
    const snapshot = await buildViewerSnapshot(root);
    const dupNodes = snapshot.graph.nodes.filter((node) => node.id === DUP);
    expect(dupNodes).toHaveLength(1);
    expect(isGhostNode(dupNodes[0]!)).toBe(false);
  });

  it("still emits a ghost for a name no page claims", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const snapshot = await buildViewerSnapshot(root);
    expect([...collectGhostIds(snapshot.graph.nodes)]).toEqual(["concepts/nowhere"]);
  });
});

describe("both commands classify the same dangling page alike", () => {
  it("never navigates to the ghost and never lists it as a linking page", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const io = captureIo();
    expect(await raceCommand("nowhere", "alpha", {})).toBe(2);
    expect(io.err()).toContain('No page named "nowhere" exists in this wiki.');
    vi.restoreAllMocks();
    const second = captureIo();
    expect(await linksHereCommand("nowhere", { json: true })).toBe(0);
    const payload = JSON.parse(second.out());
    expect(payload.target).toBe("concepts/nowhere");
    expect(payload.inbound.map((entry: { pageId: string }) => entry.pageId)).toEqual(["concepts/alpha"]);
    expect(second.err()).toBe("");
  });
});
