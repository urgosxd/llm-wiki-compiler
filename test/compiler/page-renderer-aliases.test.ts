/**
 * @file test/compiler/page-renderer-aliases.test.ts
 * @description The surviving page records the names that folded into it, so the
 * next ingest can resolve them deterministically instead of guessing (S6).
 *
 * Driven through the public renderer and the markdown it returns — the frontmatter
 * block is the observable artifact, not an internal map. The LLM call is stubbed:
 * aliases are a frontmatter concern and must not depend on the model.
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { callClaude } from "../../src/utils/llm.js";
import { renderMergedPageContent } from "../../src/compiler/page-renderer.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { makeTempRoot } from "../fixtures/temp-root.js";

vi.mock("../../src/utils/llm.js", () => ({
  callClaude: vi.fn(),
}));

/** Minimal SchemaConfig stub matching the shape page-renderer needs. */
const STUB_SCHEMA = { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2];

/** Project roots this file created, removed after each test. */
const createdRoots: string[] = [];

/** Create a temp root and remember it for teardown. */
async function tempRoot(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  createdRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Write an existing concept page, frontmatter included, under a temp root. */
async function writeExistingPage(
  root: string,
  slug: string,
  frontmatter: string,
  body = "Existing body.",
): Promise<void> {
  const dir = path.join(root, "wiki/concepts");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, "utf-8");
}

/** The concept entry the compile hands the renderer. */
function entryFor(slug: string, name: string, aliases?: string[]) {
  return {
    slug,
    concept: { concept: name, summary: `${name} summary.`, is_new: false, tags: [] },
    sourceFiles: ["source.md"],
    combinedContent: "1\tEvidence from source.md",
    ...(aliases === undefined ? {} : { aliases }),
  };
}

describe("renderMergedPageContent — folded names land in frontmatter aliases", () => {
  it("adds the folded name, keeps existing aliases, and never lists the title", async () => {
    const root = await tempRoot("page-renderer-aliases");
    await writeExistingPage(
      root,
      "vector-db",
      [
        "title: Vector Database",
        "summary: Stored vectors.",
        "sources:",
        "  - source.md",
        "kind: concept",
        "aliases:",
        "  - pgvector store",
        "createdAt: 2026-01-01T00:00:00.000Z",
        "updatedAt: 2026-01-01T00:00:00.000Z",
      ].join("\n"),
    );
    vi.mocked(callClaude).mockResolvedValue("A vector database stores embeddings.");

    const page = await renderMergedPageContent(
      root,
      entryFor("vector-db", "Vector Database", ["Vector DB", "Vector Database"]),
      STUB_SCHEMA,
    );

    const { meta } = parseFrontmatter(page);
    expect(meta.title).toBe("Vector Database");
    expect(meta.aliases).toEqual(["vector-database", "pgvector store", "Vector DB"]);
    expect(meta.aliases).not.toContain("Vector Database");
  });

  it("is idempotent: rendering the same fold twice does not duplicate the alias", async () => {
    const root = await tempRoot("page-renderer-alias-repeat");
    vi.mocked(callClaude).mockResolvedValue("A vector database stores embeddings.");
    const entry = entryFor("vector-db", "Vector Database", ["Vector DB"]);

    await renderMergedPageContent(root, entry, STUB_SCHEMA);
    const second = await renderMergedPageContent(root, entry, STUB_SCHEMA);

    const aliases = parseFrontmatter(second).meta.aliases as string[];
    expect(aliases.filter((alias) => alias === "Vector DB")).toHaveLength(1);
  });

  it("leaves a page with no folded names writing only the generated aliases", async () => {
    const root = await tempRoot("page-renderer-no-fold");
    vi.mocked(callClaude).mockResolvedValue("Body without any fold.");

    const page = await renderMergedPageContent(
      root,
      entryFor("baking-bread", "Baking Bread"),
      STUB_SCHEMA,
    );

    expect(parseFrontmatter(page).meta.aliases).toEqual(["baking-bread"]);
  });
});
