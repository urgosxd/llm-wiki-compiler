/**
 * @file test/compiler/link-gate.test.ts
 * @description ONE final link gate: every contextual link on a written page —
 * the ones the model typed inline and the ones `resolveLinks` adds from
 * plain-text mentions — passes the same decision table, the same budget and the
 * same counters immediately before that body is written (S8, S13).
 *
 * WHY THE ORDER MATTERS. A page created by the SAME compile run is not on disk
 * while its neighbours are being generated, so a gate that runs at generation
 * time demotes every link into a page the run is about to create. The gate
 * therefore runs at the LINK PHASE, after the run's pages exist: the planned page
 * set IS the page set, and a link into it resolves instead of being reported
 * missing.
 *
 * HARNESS. Each case reproduces the real order of a run: render the page (the
 * model write), store it as generation does, then run the link phase and read
 * the bytes a reader would get. The LLM call is stubbed — anchoring is a
 * post-generation rule, never a property of the model.
 */

import { vi, describe, it, expect } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { callClaude } from "../../packages/wiki/src/utils/llm.js";
import { renderMergedPageContent } from "../../packages/wiki/src/compiler/page-renderer.js";
import { resolveAndApplyLinks } from "../../packages/wiki/src/compiler/resolver.js";
import { summarizeCompile } from "../../packages/wiki/src/compiler/compile-report.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { MAX_CONTEXTUAL_LINKS_PER_PAGE } from "../../packages/wiki/src/utils/constants.js";
import { STUB_SCHEMA, usePageRendererSuite } from "../fixtures/page-renderer-suite.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { writePage } from "../fixtures/write-page.js";
import type { CompileOptions } from "../../packages/wiki/src/utils/types.js";

vi.mock("../../packages/wiki/src/utils/llm.js", () => ({ callClaude: vi.fn() }));

/** Throwaway wiki roots, one per case, plus the per-test mock restore. */
const { tempRoot } = usePageRendererSuite();

/** Absolute `wiki/concepts` directory of an isolated project root. */
function conceptsDir(root: string): string {
  return path.join(root, "wiki", "concepts");
}

/** Seed a page that already exists before the run, as an earlier compile left it. */
async function seedPage(root: string, slug: string, title: string, body: string): Promise<void> {
  await writePage(conceptsDir(root), slug, { title, summary: "s" }, body);
}

/**
 * Render one page of THIS run and store it, as generation does before the link
 * phase runs. Rendering first is the whole point: the page's neighbours may not
 * exist yet.
 *
 * @param root - Project root.
 * @param slug - Page slug.
 * @param name - Concept name, which becomes the page title.
 * @param body - The body the model returned.
 * @param aliases - Names folded into the page by the identity stage.
 */
async function writeRunPage(
  root: string,
  slug: string,
  name: string,
  body: string,
  aliases: string[] = [],
): Promise<void> {
  vi.mocked(callClaude).mockResolvedValueOnce(body);
  const entry = {
    slug,
    concept: { concept: name, summary: `${name} summary.`, is_new: true, tags: [] },
    sourceFiles: ["notes.md"],
    combinedContent: "1\tEvidence from notes.md",
    aliases,
  };
  const page = await renderMergedPageContent(root, entry, STUB_SCHEMA);
  await writeFile(path.join(conceptsDir(root), `${slug}.md`), page, "utf-8");
}

/** Run the link phase exactly as `finalizeWiki` does for this run's pages. */
async function runLinkPhase(root: string, changed: string[], added: string[]): Promise<void> {
  await resolveAndApplyLinks(root, process.env, changed, added);
}

/** The body a reader would get for one page of the isolated wiki. */
async function readBody(root: string, slug: string): Promise<string> {
  return parseFrontmatter(await readFile(path.join(conceptsDir(root), `${slug}.md`), "utf-8")).body;
}

/** How many wikilinks a body contains. */
function linkCount(body: string): number {
  return (body.match(/\[\[/gu) ?? []).length;
}

describe("link gate — the same run's pages exist", () => {
  it("keeps a link to a page this run is creating, and writes that target", async () => {
    const root = await tempRoot("gate-same-run");
    await writeRunPage(root, "networks", "Networks", "## Uses\n\nNetworks use [[vector-database|Vector DB]] daily.");
    await writeRunPage(root, "vector-database", "Vector Database", "Storage.", ["Vector DB"]);

    await runLinkPhase(root, ["networks", "vector-database"], ["networks", "vector-database"]);

    expect(await readBody(root, "networks")).toContain("Networks use [[vector-database|Vector DB]] daily.");
    expect(await readBody(root, "vector-database")).toBe("\nStorage.\n");
  });

  it("still demotes a link to a page that exists neither on disk nor in the run", async () => {
    const root = await tempRoot("gate-ghost-target");
    await writeRunPage(root, "networks", "Networks", "## Uses\n\nNetworks use [[nowhere-page|Nowhere Page]].");
    const io = captureProcessIo();

    await runLinkPhase(root, ["networks"], ["networks"]);

    expect(await readBody(root, "networks")).toBe("\n## Uses\n\nNetworks use Nowhere Page.\n");
    expect(io.out()).toContain('Contextual links in "Networks": 0 kept, 1 demoted (1 unresolved-target).');
  });
});

describe("link gate — the resolver channel is gated too", () => {
  it("demotes a self-reference that reaches the written body through the resolver", async () => {
    const root = await tempRoot("gate-self-reference");
    await seedPage(
      root, "networks", "Networks",
      "## Uses\n\nNetworks rely on [[networks|Networks]] and on Routing Tables.",
    );
    await writeRunPage(root, "routing-tables", "Routing Tables", "Tables.");

    await runLinkPhase(root, ["routing-tables"], ["routing-tables"]);

    const body = await readBody(root, "networks");
    expect(body).toBe("\n## Uses\n\nNetworks rely on Networks and on [[routing-tables|Routing Tables]].\n");
  });

  it("demotes the second resolver-created link to one target in one section", async () => {
    const root = await tempRoot("gate-redundant-link");
    await seedPage(root, "graph-theory", "Graph Theory", "Graphs.");
    await writeRunPage(root, "networks", "Networks", "## Uses\n\nGraph Theory helps. Graph Theory helps again.");

    await runLinkPhase(root, ["networks"], []);

    expect(await readBody(root, "networks"))
      .toBe("\n## Uses\n\n[[graph-theory|Graph Theory]] helps. Graph Theory helps again.\n");
  });

  it("holds the per-page budget across both channels combined", async () => {
    const root = await tempRoot("gate-shared-budget");
    const total = MAX_CONTEXTUAL_LINKS_PER_PAGE + 3;
    for (let index = 0; index < total; index += 1) {
      await seedPage(root, `topic-${index}`, `Topic ${index}`, "Topic.");
    }
    const typed = Array.from({ length: 10 }, (_, index) => `[[topic-${index}|Topic ${index}]]`).join(", ");
    const mentioned = Array.from({ length: total - 10 }, (_, index) => `Topic ${10 + index}`).join(", ");
    await writeRunPage(root, "networks", "Networks", `## All\n\n${typed}. Named: ${mentioned}.`);

    await runLinkPhase(root, ["networks"], []);

    expect(linkCount(await readBody(root, "networks"))).toBe(MAX_CONTEXTUAL_LINKS_PER_PAGE);
  });
});

describe("link gate — one aggregate line for the run", () => {
  it("reports the run's kept and demoted link totals alongside the per-page detail", () => {
    const io = captureProcessIo();
    const generation = {
      pages: [], writtenPages: [], errors: [], candidates: [],
      review: { held: [], forced: [] }, seedSlugs: [],
      linkCounts: {
        kept: 3,
        demoted: { "unresolved-target": 0, "self-reference": 1, unanchored: 0, redundant: 1, "over-budget": 0 },
      },
    };

    summarizeCompile(
      { toCompile: [], deleted: [], unchanged: [] }, generation, [], {} as CompileOptions, [],
    );

    expect(io.out()).toContain("Contextual links in this run: 3 kept, 2 demoted (1 self-reference, 1 redundant).");
  });
});

describe("link gate — behaviour that must not be lost", () => {
  it("still links a plain-text mention of a real page title", async () => {
    const root = await tempRoot("gate-mention-kept");
    await seedPage(root, "graph-theory", "Graph Theory", "Graphs.");
    await writeRunPage(root, "networks", "Networks", "Networks use Graph Theory daily.");

    await runLinkPhase(root, ["networks"], []);

    expect(await readBody(root, "networks")).toBe("\nNetworks use [[graph-theory|Graph Theory]] daily.\n");
  });

  it("keeps a link to a queries-namespace page, which the page set has always resolved", async () => {
    const root = await tempRoot("gate-queries-target");
    await writePage(path.join(root, "wiki", "queries"), "saved", { title: "Saved Query" }, "Query body.");
    await writeRunPage(root, "networks", "Networks", "## Uses\n\nNetworks use [[queries/saved|Saved Query]] daily.");

    await runLinkPhase(root, ["networks"], ["networks"]);

    expect(await readBody(root, "networks")).toContain("[[queries/saved|Saved Query]]");
  });

  it("leaves a page with no links and no mentions byte-identical", async () => {
    const root = await tempRoot("gate-no-links");
    await writeRunPage(root, "networks", "Networks", "Networks hold facts.");

    await runLinkPhase(root, ["networks"], ["networks"]);

    expect(await readBody(root, "networks")).toBe("\nNetworks hold facts.\n");
  });
});
