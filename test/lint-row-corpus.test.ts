/**
 * @file test/lint-row-corpus.test.ts
 * @description A lint run against a Stack's pages must judge those pages.
 *
 * WHY THIS EXISTS
 *
 * Every rule read pages through `collectAllPages`, which walks `wiki/concepts` and
 * `wiki/queries`. A Stack-backed project has neither, so the linter walked an
 * empty tree and answered "nothing is wrong" — for a corpus it never read.
 * Measured: a root with no `wiki/` returns `{errors: 0, warnings: 0}`; the same
 * corpus materialized on disk returns findings.
 *
 * The corpus now travels in an async scope, so rules keep their signatures. These
 * tests pin the two halves that can each fail silently: the row corpus is what the
 * rules see, and the disk path is untouched when no Stack is configured.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import * as seam from "../src/dimensions/wiki/page-source-seam.js";
import { lint } from "../src/linter/index.js";
import type { RawWikiPage } from "../src/wiki/collect.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A page as the row-backed raw source returns it: frontmatter ALREADY stripped. */
function rawPage(slug: string, fields: Record<string, unknown>, body: string): RawWikiPage {
  return {
    slug,
    pageDirectory: "concepts",
    filePath: `/virtual/wiki/concepts/${slug}.md`,
    title: typeof fields.title === "string" ? fields.title : slug,
    frontmatter: fields,
    body,
    parseStatus: {
      hasFrontmatterBlock: true,
      malformedFrontmatter: false,
      hasTitle: true,
      orphaned: fields.orphaned === true,
    },
  };
}

/** Serve the given pages as this project's corpus, as a configured Stack would. */
function withRowCorpus(pages: RawWikiPage[]) {
  vi.spyOn(seam, "withRawPageSource").mockImplementation(
    async (_root, _env, fn) => await fn({ collect: async () => pages }),
  );
}

/** A project root with no `wiki/` at all — the state a Stack-backed project is in. */
async function stackProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "lint-rows-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

describe("lint against a row corpus", () => {
  it("reports findings from the rows instead of a clean verdict on an unread tree", async () => {
    dir = await stackProject();
    withRowCorpus([
      // Empty body: `checkEmptyPages` fires. Title present so it is a real page.
      rawPage("empty-one", { title: "Empty One", summary: "s" }, ""),
      rawPage("empty-two", { title: "Empty Two", summary: "s" }, "   "),
    ]);

    const summary = await lint(dir);

    expect(summary.errors + summary.warnings).toBeGreaterThan(0);
  });

  it("reports nothing when the row corpus is genuinely clean", async () => {
    dir = await stackProject();
    withRowCorpus([
      rawPage("fine", { title: "Fine Page", summary: "A summary." }, "A body with enough prose to pass the empty check."),
    ]);

    const summary = await lint(dir);

    // The point is not "always find something" -- it is that the verdict is about
    // the pages that exist, not about a directory that does not.
    expect(summary.errors).toBe(0);
  });

  it("reconstructs frontmatter so metadata rules still see their fields", async () => {
    dir = await stackProject();
    withRowCorpus([
      rawPage("orphaned-page", { title: "Orphaned", summary: "s", orphaned: true }, "Body text long enough."),
    ]);

    const summary = await lint(dir);

    // `orphaned` is a stored column, so it survives the round trip and the rule
    // that reads frontmatter sees it. A page served as bare body would parse as
    // having no metadata and this rule would silently never fire.
    expect(summary.warnings + summary.errors).toBeGreaterThan(0);
  });
});

describe("lint with no Stack configured", () => {
  it("still walks disk when no row corpus is supplied", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lint-disk-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/empty.md"), "---\ntitle: Empty\nsummary: s\n---\n\n");
    // No seam mocked: `withRawPageSource` is the real one, which yields undefined
    // without a Stack and lets the rule fall back to the disk walk.

    const summary = await lint(dir);

    expect(summary.errors + summary.warnings).toBeGreaterThan(0);
  });
});
