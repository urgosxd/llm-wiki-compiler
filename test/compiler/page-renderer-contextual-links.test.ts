/**
 * @file test/compiler/page-renderer-contextual-links.test.ts
 * @description The page writer validates the contextual links the model wrote,
 * and the only way relatedness becomes a link is a REAL mention of a real page
 * (S8, S12).
 *
 * Driven through `renderMergedPageContent`, the single renderer both the live
 * write path and the review path use, so what these cases assert is exactly what
 * a reader of the written page would see. The LLM call is stubbed: link
 * anchoring is a post-generation validation, never a property of the model.
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { callClaude } from "../../src/utils/llm.js";
import { renderMergedPageContent } from "../../src/compiler/page-renderer.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { useManagedTempRoots } from "../fixtures/temp-root.js";
import { writePage } from "../fixtures/write-page.js";
import { captureProcessIo } from "../fixtures/process-io.js";

vi.mock("../../src/utils/llm.js", () => ({
  callClaude: vi.fn(),
}));

/** Minimal SchemaConfig stub matching the shape page-renderer needs. */
const STUB_SCHEMA = { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2];

/** Throwaway wiki roots, one per case, removed after each test. */
const { tempRoot } = useManagedTempRoots();

afterEach(() => {
  vi.restoreAllMocks();
});

/** Write a page into the throwaway wiki's concepts directory. */
async function writeConceptPage(
  root: string,
  slug: string,
  fields: Record<string, unknown>,
  body = "Body.",
): Promise<void> {
  await writePage(path.join(root, "wiki/concepts"), slug, fields, body);
}

/** The concept entry the compile hands the renderer. */
function entryFor(slug: string, name: string, aliases?: string[]) {
  return {
    slug,
    concept: { concept: name, summary: `${name} summary.`, is_new: true, tags: [] },
    sourceFiles: ["notes.md"],
    combinedContent: "1\tEvidence from notes.md",
    ...(aliases === undefined ? {} : { aliases }),
  };
}

/** Render one page whose generated body is exactly `body`. */
async function render(root: string, entry: ReturnType<typeof entryFor>, body: string): Promise<string> {
  vi.mocked(callClaude).mockResolvedValue(body);
  return await renderMergedPageContent(root, entry, STUB_SCHEMA);
}

describe("page rendering with no contextual links", () => {
  it("writes a link-free body byte for byte and keeps its citation anchors", async () => {
    const root = await tempRoot("renderer-no-links");
    const io = captureProcessIo();

    const page = await render(root, entryFor("networks", "Networks"), "Networks hold.^[notes.md:3-4]");

    const { meta, body } = parseFrontmatter(page);
    expect(body).toBe("\nNetworks hold.^[notes.md:3-4]\n");
    expect(meta.title).toBe("Networks");
    expect(io.out()).not.toContain("Contextual links");
  });

  it("adds no link when the only relatedness is the context handed to the model", async () => {
    const root = await tempRoot("renderer-context-only");
    await writeConceptPage(root, "caching", { title: "Caching" }, "Caching stores values.");

    const page = await render(root, entryFor("networks", "Networks"), "Networks hold facts.");

    expect(page).not.toContain("[[");
    const system = String(vi.mocked(callClaude).mock.calls.at(-1)?.[0].system);
    expect(system).toContain("Related wiki pages for cross-referencing:");
    expect(system).toContain("title: Caching");
  });
});

describe("page rendering with demoted contextual links", () => {
  it("reports kept and demoted links by reason", async () => {
    const root = await tempRoot("renderer-report");
    await writeConceptPage(root, "graph-theory", { title: "Graph Theory" });
    const io = captureProcessIo();
    const body = [
      "## Uses",
      "",
      "Uses [[graph-theory|Graph Theory]] and [[missing|Missing Thing]] and [[graph-theory|other words]].",
    ].join("\n");

    await render(root, entryFor("networks", "Networks"), body);

    expect(io.out()).toContain(
      'Contextual links in "Networks": 1 kept, 2 demoted (1 unresolved-target, 1 unanchored).',
    );
  });

  it("leaves frontmatter untouched when the generated body loses a link", async () => {
    const root = await tempRoot("renderer-frontmatter");
    await writeConceptPage(root, "networks", {
      title: "Networks",
      summary: "Old summary.",
      sources: ["notes.md"],
      kind: "concept",
      aliases: ["Network Science"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, "Old body.");

    const page = await render(root, entryFor("networks", "Networks"), "Uses [[ghost-page|Ghost Page]] here.");

    const { meta, body } = parseFrontmatter(page);
    expect(meta.title).toBe("Networks");
    expect(meta.sources).toEqual(["notes.md"]);
    expect(meta.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(meta.aliases).toEqual(["Network Science"]);
    expect(body).toBe("\nUses Ghost Page here.\n");
  });
});
