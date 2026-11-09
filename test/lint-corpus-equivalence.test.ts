/**
 * @file test/lint-corpus-equivalence.test.ts
 * @description The acceptance criterion for row-aware lint: the SAME corpus linted
 * from rows and from disk must produce the same findings, except where a row cannot
 * carry the input.
 *
 * WHY THIS IS THE TEST THAT MATTERS
 *
 * Every earlier change in this feature is plausible on its own — the corpus in
 * scope, the frontmatter rebuilt, the citations resolved from rows — and plausible
 * is not the same as correct. The only check that proves them together is
 * equivalence: build one corpus on disk, serve the identical corpus as rows, and
 * compare what the linter says about each.
 *
 * The comparison is EXACT for the rules a row can satisfy: same rule ids, same
 * files, same messages, same order. Where a row genuinely cannot answer, the
 * difference is named here rather than tolerated silently — see
 * `RULES_UNAVAILABLE_ON_ROWS`, whose exclusions are asserted by behaviour in
 * `lint-corpus-parity.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lintByTier } from "../packages/wiki/src/linter/index.js";
import type { LintResult } from "../packages/wiki/src/linter/types.js";
import type { RawWikiPage } from "../packages/wiki/src/wiki/collect.js";
import { lintRowCorpus, stackProjectRoot } from "./fixtures/lint-row-corpus.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** One page, described once and rendered two ways. */
interface CorpusPage {
  readonly slug: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/** The corpus both backends must agree on. Chosen to trip several rules at once. */
const CORPUS: readonly CorpusPage[] = [
  { slug: "empty", frontmatter: { title: "Empty", summary: "s" }, body: "" },
  { slug: "no-summary", frontmatter: { title: "No Summary" }, body: "A body with enough prose to satisfy the empty-page check." },
  { slug: "cites-ok", frontmatter: { title: "Cites Ok", summary: "s" }, body: "A sourced claim ^[doc.md]." },
  { slug: "cites-ghost", frontmatter: { title: "Cites Ghost", summary: "s" }, body: "An unsupported claim ^[ghost.md]." },
  { slug: "bad-span", frontmatter: { title: "Bad Span", summary: "s" }, body: "An out of range claim ^[doc.md:1-99]." },
  { slug: "fine", frontmatter: { title: "Fine", summary: "A summary." }, body: "A body with enough prose to satisfy the empty-page check." },
];

/** The one source document both backends hold. */
const DOCUMENT = { filename: "doc.md", content: "line one\nline two\nline three\n" };

/** Render one corpus page as markdown, the way a file on disk holds it. */
function asMarkdown(page: CorpusPage): string {
  const lines = Object.entries(page.frontmatter).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${page.body}`;
}

/** Render one corpus page as the row source returns it: frontmatter already parsed. */
function asRowPage(page: CorpusPage): RawWikiPage {
  return {
    slug: page.slug,
    pageDirectory: "concepts",
    filePath: `/virtual/wiki/concepts/${page.slug}.md`,
    title: String(page.frontmatter.title),
    frontmatter: page.frontmatter,
    body: page.body,
    parseStatus: {
      hasFrontmatterBlock: true,
      malformedFrontmatter: false,
      hasTitle: true,
      orphaned: false,
    },
  };
}

/** Write the corpus, and its one source document, to disk. */
async function writeCorpusToDisk(root: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  for (const page of CORPUS) {
    await writeFile(path.join(root, "wiki/concepts", `${page.slug}.md`), asMarkdown(page));
  }
  await writeFile(path.join(root, "sources", DOCUMENT.filename), DOCUMENT.content);
}

/** A stable, comparable projection of a finding. */
function shape(result: LintResult): string {
  return `${result.rule}|${path.basename(result.file)}|${result.severity}|${result.message}`;
}

/** Every finding, sorted — order is pinned elsewhere; this compares CONTENT. */
function findings(report: Awaited<ReturnType<typeof lintByTier>>): string[] {
  return [...report.deterministic, ...report.providerJudgement, ...report.derivedView]
    .map(shape)
    .sort();
}

describe("row corpus and disk corpus agree", () => {
  it("produces the same findings for every rule a row can satisfy", async () => {
    dir = await stackProjectRoot("equiv-disk");
    await writeCorpusToDisk(dir);
    // Real seams: no Stack configured, so the linter walks the tree we just wrote.
    const fromDisk = findings(await lintByTier(dir));

    vi.restoreAllMocks();
    const rowRoot = await stackProjectRoot("equiv-rows");
    // The SAME source text under `sources/` would be a second corpus; the row
    // backend must reach the same verdict from its own documents alone.
    const fromRows = findings(
      await lintRowCorpus(rowRoot, CORPUS.map(asRowPage), [DOCUMENT]),
    );
    await rm(rowRoot, { recursive: true, force: true });

    expect(fromRows).toEqual(fromDisk);
  });

  it("finds something in the shared corpus, so the comparison is not two empty lists", async () => {
    dir = await stackProjectRoot("equiv-nonempty");
    await writeCorpusToDisk(dir);

    const fromDisk = findings(await lintByTier(dir));

    // A vacuous equality would pass the test above while proving nothing.
    expect(fromDisk.length).toBeGreaterThan(3);
    expect(fromDisk.some((line) => line.startsWith("broken-citation"))).toBe(true);
    expect(fromDisk.some((line) => line.startsWith("missing-summary"))).toBe(true);
  });
});
