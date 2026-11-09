/**
 * @file Contract tests for the one shared target-name resolver.
 *
 * WHY THIS FILE EXISTS. `llmwiki links-here` and `llmwiki race` both accept a
 * page name typed by a human: either the namespaced id (`concepts/foo`) or the
 * bare slug (`foo`). Two implementations of that question is two answers for
 * the same input, so the precedence chain lives in `resolve-target.ts` alone and
 * this file pins it: exact id, then the default `concepts/` directory, then any
 * other directory, and never a guess about case or a partial slug.
 *
 * THE ONE DELIBERATE DIFFERENCE. The chain is shared; the set of ELIGIBLE nodes
 * is a parameter. `race` asks "which real page is this?" and a dangling target
 * has no article to stand on, so it is refused. `links-here` asks "which pages
 * point at this name?" and a broken target is a legitimate answer — listing who
 * mentions it is how you find the page that needs fixing. The last describe
 * block pins both scopes on the SAME graph so the difference is stated once,
 * here, instead of hiding inside two modules.
 */

import { describe, expect, it } from "vitest";
import { resolveTargetNodeId } from "../../packages/wiki/src/context/resolve-target.js";
import { syntheticGraph } from "../fixtures/graph-data.js";
import type { PageId } from "../../packages/wiki/src/viewer/types.js";

const ALPHA = "concepts/alpha" as PageId;
const REPORT = "queries/alpha-report" as PageId;
const QUALITY = "concepts/quality" as PageId;
const QUALITY_QUERY = "queries/quality" as PageId;
const NOWHERE = "concepts/nowhere" as PageId;

/** Real-only graph helper: the resolver never needs edges. */
function graphOf(realIds: PageId[], ghostIds: PageId[] = []) {
  return syntheticGraph({ realIds, edges: [], ghostIds });
}

describe("resolveTargetNodeId — precedence", () => {
  it("resolves an exact namespaced id to itself", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), "concepts/alpha")).toBe(ALPHA);
  });

  it("resolves a bare slug to the default concepts directory", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), "alpha")).toBe(ALPHA);
  });

  it("resolves a bare slug that only exists in another directory", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA, REPORT]), "alpha-report")).toBe(REPORT);
  });

  it("prefers concepts/ when two directories claim the same slug", () => {
    const graph = graphOf([QUALITY_QUERY, QUALITY]);
    expect(resolveTargetNodeId(graph, "quality")).toBe(QUALITY);
  });

  it("resolves an exact namespaced id in a non-default directory", () => {
    const graph = graphOf([ALPHA, REPORT]);
    expect(resolveTargetNodeId(graph, "queries/alpha-report")).toBe(REPORT);
  });
});

describe("resolveTargetNodeId — what it refuses", () => {
  it("does not treat a slug prefix as a match", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), "alph")).toBe(null);
  });

  it("returns null for a name no node matches", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), "gamma")).toBe(null);
  });

  it("returns null for the empty string instead of matching something", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), "")).toBe(null);
  });

  it("is case-sensitive rather than guessing a near match", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), "Alpha")).toBe(null);
  });

  it("does not trim surrounding whitespace into a different page", () => {
    expect(resolveTargetNodeId(graphOf([ALPHA]), " alpha")).toBe(null);
  });
});

describe("resolveTargetNodeId — determinism", () => {
  it("answers the same for the same nodes in a different order", () => {
    const forward = graphOf([QUALITY, QUALITY_QUERY]);
    const reversed = graphOf([QUALITY_QUERY, QUALITY]);
    expect(resolveTargetNodeId(forward, "quality")).toBe(resolveTargetNodeId(reversed, "quality"));
  });
});

describe("resolveTargetNodeId — eligible-node scope", () => {
  it("refuses a dangling target when only real pages are eligible", () => {
    const graph = graphOf([ALPHA], [NOWHERE]);
    expect(resolveTargetNodeId(graph, "nowhere", "article")).toBe(null);
    expect(resolveTargetNodeId(graph, "nowhere")).toBe(null);
  });

  it("resolves a dangling target for a caller that asks for referenced nodes", () => {
    const graph = graphOf([ALPHA], [NOWHERE]);
    expect(resolveTargetNodeId(graph, "nowhere", "include-dangling")).toBe(NOWHERE);
  });

  it("keeps the ghost out of the concepts preference unless it is eligible", () => {
    // RECORDED DIVERGENCE: a broken link `[[quality]]` produces the ghost
    // `concepts/quality` even when a real `queries/quality` page exists. An
    // article-scope caller must reach the real page; a caller asking who
    // mentions the broken name must reach the ghost. Same chain, different
    // candidate set — never two chains.
    const graph = graphOf([QUALITY_QUERY], [QUALITY]);
    expect(resolveTargetNodeId(graph, "quality", "article")).toBe(QUALITY_QUERY);
    expect(resolveTargetNodeId(graph, "quality", "include-dangling")).toBe(QUALITY);
  });
});
