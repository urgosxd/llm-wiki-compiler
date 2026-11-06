/**
 * @file test/compiler/page-renderer-related-pages.test.ts
 * @description The cross-reference context a page-generation prompt receives is a
 * RELEVANCE ranking, not an alphabetical slice (S9, S14).
 *
 * The defect this pins: taking the first N slugs of the directory handed the model
 * whichever pages happened to sort first, so the "related pages" it was shown had
 * nothing to do with the concept being written. Ranking stays retrieval context
 * only -- the pages listed here never become links, which
 * `page-renderer-contextual-links.test.ts` already pins.
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { rm } from "node:fs/promises";
import { callClaude } from "../../src/utils/llm.js";
import { rankRelatedSlugs, renderMergedPageContent } from "../../src/compiler/page-renderer.js";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { writePage } from "../fixtures/write-page.js";

vi.mock("../../src/utils/llm.js", () => ({
  callClaude: vi.fn(),
}));

/** Roots this file created, removed after each test so nothing is left behind. */
const created: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A throwaway wiki root, remembered for teardown. */
async function freshWiki(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  created.push(root);
  return root;
}

/** Write one earlier concept page into a throwaway wiki. */
async function writeConcept(root: string, slug: string, title: string, body: string): Promise<void> {
  await writePage(path.join(root, "wiki/concepts"), slug, { title }, body);
}

/** The project bodies the ranking scores, keyed by the slug that carries each. */
const BODIES: Record<string, string> = {
  a: "Nothing relevant here.",
  b: "A Vector Store keeps vectors.",
  c: "Nothing relevant here either.",
  d: "Still nothing relevant.",
  e: "The Vector Database stores vectors.",
  f: "Another Vector Database note.",
};

/** The system prompt of the last generation call. */
function lastSystemPrompt(): string {
  return String(vi.mocked(callClaude).mock.calls.at(-1)?.[0].system);
}

describe("relatedPages ranking", () => {
  it("V7 ranks title mentions, then alias mentions, then slug, and is not the alphabetical slice", async () => {
    const root = await freshWiki("renderer-ranked");
    for (const [slug, body] of Object.entries(BODIES)) {
      await writeConcept(root, slug, `Title ${slug}`, body);
    }
    const candidates = Object.entries(BODIES).map(([slug, content]) => ({ slug, content }));
    const names = ["Vector Database", "Vector Store"];

    const ranked = rankRelatedSlugs(candidates, names, "vector-db", 5);

    expect(ranked).toEqual(["e", "f", "b", "a", "c"]);
    expect(ranked).not.toEqual(["a", "b", "c", "d", "e"]);

    vi.mocked(callClaude).mockResolvedValue("Body.");
    await renderMergedPageContent(root, {
      slug: "vector-db",
      concept: { concept: "Vector Database", summary: "Vectors.", is_new: true, tags: [] },
      sourceFiles: ["notes.md"],
      combinedContent: "1\tEvidence",
      aliases: ["Vector Store"],
    }, { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2]);

    const prompt = lastSystemPrompt();
    expect(prompt).toContain("Related wiki pages for cross-referencing:");
    expect(prompt.indexOf("title: Title e")).toBeLessThan(prompt.indexOf("title: Title f"));
    expect(prompt.indexOf("title: Title f")).toBeLessThan(prompt.indexOf("title: Title b"));
  });

  it("keeps every page, in slug order, when there are fewer pages than the context limit", async () => {
    const root = await freshWiki("renderer-few");
    await writeConcept(root, "caching", "Caching", "Caching stores values.");
    await writeConcept(root, "graph-theory", "Graph Theory", "Graphs have edges.");
    const candidates = [
      { slug: "caching", content: "Caching stores values." },
      { slug: "graph-theory", content: "Graphs have edges." },
    ];

    expect(rankRelatedSlugs(candidates, ["Vector Database"], "vector-db", 5))
      .toEqual(["caching", "graph-theory"]);

    vi.mocked(callClaude).mockResolvedValue("Body.");
    await renderMergedPageContent(root, {
      slug: "vector-db",
      concept: { concept: "Vector Database", summary: "Vectors.", is_new: true, tags: [] },
      sourceFiles: ["notes.md"],
      combinedContent: "1\tEvidence",
    }, { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2]);

    const prompt = lastSystemPrompt();
    expect(prompt).toContain("Related wiki pages for cross-referencing:");
    expect(prompt).toContain("title: Caching");
    expect(prompt).toContain("title: Graph Theory");
  });
});
