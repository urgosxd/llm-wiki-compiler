/**
 * @file test/fixtures/lint-row-corpus.ts
 * @description Shared harness for the row-corpus lint tests.
 *
 * ## Why this exists rather than two copies
 *
 * Three suites drive the linter against a Stack corpus by mocking the same two
 * seams. The risk of a copy is specific: a version that stubbed `withRawPageSource`
 * but NOT `withSourceDocuments` would leave the citation rules reading `sources/`,
 * and the suite would pass while asserting nothing about the path it claims to
 * cover.
 *
 * The doc key is the one that matters and is easy to get wrong: a page cites the
 * source FILENAME (`^[abc123.md]`), while a row is keyed by its source IDENTITY (a
 * capability URL). `filename` is the column that joins them.
 */
import { vi } from "vitest";
import * as seam from "../../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintByTier } from "../../packages/wiki/src/linter/index.js";
import type { RawWikiPage } from "../../packages/wiki/src/wiki/collect.js";

/** One concept page as a row-backed source returns it (frontmatter stripped). */
export function rawPage(
  slug: string,
  fields: Record<string, unknown>,
  body = "A body with enough prose to satisfy the empty-page check comfortably.",
): RawWikiPage {
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

/** A StoredSourceDocument as the row store returns it. */
export interface RowDocument {
  /** Filename a page cites; the join key to `wiki.source_documents`. */
  readonly filename: string;
  /** Full text, which the claim-span check counts lines in. */
  readonly content: string;
}

/**
 * A project root with no `wiki/` and no `.llmwiki/` — the shape a Stack-backed
 * project actually has.
 *
 * Deliberately empty: a Stack's corpus, its source documents and its compile state
 * all live in rows keyed by stack id. A fixture that seeded `.llmwiki/state.json`
 * would be testing the FILE backend while claiming to test the row one, and would
 * pass for as long as nobody noticed the two had diverged.
 */
export async function stackProjectRoot(suffix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `lint-${suffix}-`));
}

/**
 * Lint a Stack corpus: the given pages, and optionally the given documents.
 *
 * Both seams are stubbed together on purpose. Stubbing only one leaves the other
 * reading disk, which is the exact failure this feature removes.
 *
 * @param root - Where to lint.
 * @param pages - Pages the corpus holds.
 * @param documents - Source documents the corpus holds; omit for a corpus with none.
 * @returns The tiered report.
 */
export async function lintRowCorpus(
  root: string,
  pages: readonly RawWikiPage[],
  documents: readonly RowDocument[] = [],
): Promise<Awaited<ReturnType<typeof lintByTier>>> {
  vi.spyOn(seam, "withRawPageSource").mockImplementation(
    async (_root, _env, fn) => await fn({ collect: async () => [...pages] }),
  );
  vi.spyOn(seam, "withSourceDocuments").mockImplementation(
    async (_env, fn) =>
      await fn({
        list: async () =>
          documents.map((doc) => ({
            sourceIdentity: `https://example.test/${doc.filename}`,
            contentHash: "h",
            content: doc.content,
            filename: doc.filename,
          })),
      }),
  );
  return await lintByTier(root);
}

/** Every rule id a tiered report mentions, across all three tiers. */
export function reportedRuleIds(
  report: Awaited<ReturnType<typeof lintByTier>>,
): string[] {
  return [...report.deterministic, ...report.providerJudgement, ...report.derivedView]
    .map((result) => result.rule);
}

/** Write one concept page on disk, for the file-backed control case. */
export async function writeDiskPage(
  root: string,
  slug: string,
  markdown: string,
): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), markdown);
}
