/**
 * @file test/compiler/link-review.test.ts
 * @description The incremental review stage of S9: when an article is created or
 * updated, earlier pages that really mention it are RETRIEVED deterministically,
 * JUDGED by the model, and edited surgically -- and nothing else in the wiki is
 * touched, truncated silently, or written from similarity.
 *
 * Every case drives `reviewEarlierPages`, the stage's public entry point, and
 * asserts on the bytes of the pages on disk: an untouched page must be
 * byte-identical, and a modified page must differ in exactly one span. The review
 * call is stubbed (`callClaude`), because the point of these cases is what the
 * stage does with a verdict, not what a model would answer.
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { callClaude } from "../../src/utils/llm.js";
import {
  describeLinkReview,
  reviewEarlierPages,
  type LinkReviewArticle,
  type LinkReviewCounts,
} from "../../src/compiler/link-review.js";
import {
  MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE,
  MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN,
} from "../../src/utils/constants.js";
import { useManagedTempRoots } from "../fixtures/temp-root.js";
import { writePage } from "../fixtures/write-page.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";

vi.mock("../../src/utils/llm.js", () => ({
  callClaude: vi.fn(),
}));

/** Throwaway wiki roots, one per case, removed after each test. */
const { tempRoot } = useManagedTempRoots();

afterEach(() => {
  vi.restoreAllMocks();
});

/** The concepts directory of a throwaway wiki. */
function conceptsDir(root: string): string {
  return path.join(root, "wiki/concepts");
}

/** The one article this run created, as the review stage receives it. */
function articleFor(slug: string, title: string, aliases: readonly string[] = []): LinkReviewArticle {
  return { slug, title, aliases };
}

/**
 * Write the article page the run just produced, so the link target is real.
 *
 * `aliases` are the names the page DECLARES IN ITS FRONTMATTER, which is what an
 * earlier ingest persisted for it. They are deliberately separate from the
 * `LinkReviewArticle` the stage receives, which carries only the names THIS run
 * folded -- the two sources a retrieval predicate has to union.
 */
async function writeArticle(
  root: string,
  slug: string,
  title: string,
  aliases: readonly string[] = [],
): Promise<void> {
  const fields = aliases.length === 0 ? { title } : { title, aliases };
  await writePage(conceptsDir(root), slug, fields, "The article the run just wrote.");
}

/** Write an earlier page of the wiki, with whatever body the case needs. */
async function writeEarlierPage(root: string, slug: string, title: string, body: string): Promise<void> {
  await writePage(conceptsDir(root), slug, { title }, body);
}

/** One structured verdict, as the review prompt's tool returns it. */
function verdict(shouldLink: boolean, mention: string): string {
  return JSON.stringify({ should_link: shouldLink, mention });
}

/** One page's bytes as they are on disk right now. */
async function readPage(root: string, slug: string): Promise<string> {
  return await readFile(path.join(conceptsDir(root), `${slug}.md`), "utf-8");
}

/** Review the wiki for the one article every case in this file writes. */
async function reviewArticle(root: string): Promise<LinkReviewCounts> {
  return await reviewEarlierPages(root, [articleFor("vector-db", "Vector Database")]);
}

/** Assert the run never asked the model anything and left every byte alone. */
async function expectNoContact(root: string, before: Map<string, string>): Promise<void> {
  expect(vi.mocked(callClaude)).not.toHaveBeenCalled();
  expect(changedPaths(before, await fingerprintTree(root))).toEqual([]);
}

describe("link review — an accepted verdict edits one span and nothing else", () => {
  it("V1 adds exactly one anchored link and leaves every other byte alone", async () => {
    const root = await tempRoot("link-review-yes");
    await writeArticle(root, "vector-db", "Vector Database");
    const body = "Caching stores values.\n\nA Vector Database index keeps it fast.";
    await writeEarlierPage(root, "caching", "Caching", body);
    const before = await readPage(root, "caching");
    vi.mocked(callClaude).mockResolvedValue(verdict(true, "Vector Database"));

    const counts = await reviewArticle(root);

    const after = await readPage(root, "caching");
    expect(after).toBe(before.replace(
      "A Vector Database index",
      "A [[vector-db|Vector Database]] index",
    ));
    expect(counts.linksAdded).toBe(1);
    expect(counts.modified).toBe(1);
  });
});

describe("link review — a refused verdict leaves the page untouched", () => {
  it("V2 writes nothing when the model says the link does not help here", async () => {
    const root = await tempRoot("link-review-no");
    await writeArticle(root, "vector-db", "Vector Database");
    await writeEarlierPage(root, "caching", "Caching", "A Vector Database sits behind the cache.");
    const before = await fingerprintTree(root);
    vi.mocked(callClaude).mockResolvedValue(verdict(false, "Vector Database"));

    const counts = await reviewArticle(root);

    expect(changedPaths(before, await fingerprintTree(root))).toEqual([]);
    expect(counts.modified).toBe(0);
    expect(counts.verdicts.refused).toBe(1);
  });
});

describe("link review — bounds are named, counted and reported", () => {
  it("V3 truncates past the per-article candidate cap and reports the reason", async () => {
    const root = await tempRoot("link-review-article-cap");
    await writeArticle(root, "vector-db", "Vector Database");
    const total = MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE + 1;
    for (let index = 0; index < total; index += 1) {
      await writeEarlierPage(root, `page-${index}`, `Page ${index}`, "Mentions Vector Database here.");
    }
    vi.mocked(callClaude).mockResolvedValue(verdict(false, "Vector Database"));

    const counts = await reviewArticle(root);

    expect(counts.candidates).toBe(MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE);
    expect(counts.reviewed).toBe(MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE);
    expect(counts.truncated["article-cap"]).toBe(1);
    expect(describeLinkReview(counts)).toContain("1 article-cap");
  });

  it("V4 stops modifying earlier pages at the per-run cap and reports the reason", async () => {
    const root = await tempRoot("link-review-modify-cap");
    await writeArticle(root, "vector-db", "Vector Database");
    const total = MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN + 1;
    for (let index = 0; index < total; index += 1) {
      await writeEarlierPage(root, `page-${index}`, `Page ${index}`, "Mentions Vector Database here.");
    }
    vi.mocked(callClaude).mockResolvedValue(verdict(true, "Vector Database"));

    const counts = await reviewArticle(root);

    expect(counts.reviewed).toBe(total);
    expect(counts.modified).toBe(MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN);
    expect(counts.linksAdded).toBe(MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN);
    expect(counts.truncated["modify-cap"]).toBe(1);
    expect(describeLinkReview(counts)).toContain("1 modify-cap");
    // The page past the cap is untouched: the bound refuses a write, not a review.
    expect(await readPage(root, `page-${total - 1}`)).not.toContain("[[");
  });
});

describe("link review — similarity never creates or proposes a link", () => {
  it("V5 leaves a thematically similar page alone when it never names the article", async () => {
    const root = await tempRoot("link-review-similar");
    await writeArticle(root, "vector-db", "Vector Database");
    await writeEarlierPage(
      root,
      "distributed-systems",
      "Distributed Systems",
      "Distributed Systems replicate state for availability and tolerate partitions.",
    );
    const before = await fingerprintTree(root);
    vi.mocked(callClaude).mockResolvedValue(verdict(true, "Distributed Systems"));

    const counts = await reviewArticle(root);

    await expectNoContact(root, before);
    expect(counts.candidates).toBe(0);
  });
});

describe("link review — aliases persisted by an earlier ingest still retrieve", () => {
  it("V7 offers the article to a page that mentions only a stored frontmatter alias", async () => {
    const root = await tempRoot("link-review-declared-alias");
    await writeArticle(root, "vector-db", "Vector Database", ["Vector Store"]);
    await writeEarlierPage(
      root,
      "caching",
      "Caching",
      "Caching stores values.\n\nA Vector Store keeps them fast.",
    );
    const before = await readPage(root, "caching");
    vi.mocked(callClaude).mockResolvedValue(verdict(true, "Vector Store"));

    // The article carries NO aliases from this run: "Vector DB" exists only in the
    // page's stored frontmatter, which is exactly what T2 persists so identity stays
    // deterministic across runs.
    const counts = await reviewArticle(root);

    expect(counts.candidates).toBe(1);
    expect(counts.reviewed).toBe(1);
    expect(counts.linksAdded).toBe(1);
    expect(counts.verdicts).toEqual({ accepted: 1, refused: 0, unusable: 0 });
    expect(await readPage(root, "caching")).toBe(
      before.replace("A Vector Store keeps", "A [[vector-db|Vector Store]] keeps"),
    );
  });

  it("V8 PIN does not double-count a stored alias equal to the title", async () => {
    const root = await tempRoot("link-review-title-alias");
    await writeArticle(root, "vector-db", "Vector Database", ["Vector Database"]);
    await writeEarlierPage(root, "caching", "Caching", "A Vector Database index keeps it fast.");
    const before = await readPage(root, "caching");
    vi.mocked(callClaude).mockResolvedValue(verdict(true, "Vector Database"));

    const counts = await reviewArticle(root);

    // The title reaches the predicate ONCE even though the page also declares it as
    // its own alias: one candidate, one review call, one link.
    expect(vi.mocked(callClaude)).toHaveBeenCalledTimes(1);
    expect(counts.candidates).toBe(1);
    expect(counts.reviewed).toBe(1);
    expect(await readPage(root, "caching")).toBe(
      before.replace("A Vector Database index", "A [[vector-db|Vector Database]] index"),
    );
  });
});

describe("link review — a wiki with no candidate mention costs nothing", () => {
  it("V6 performs zero writes and no review calls when no page mentions the article", async () => {
    const root = await tempRoot("link-review-pin");
    await writeArticle(root, "vector-db", "Vector Database");
    await writeEarlierPage(root, "caching", "Caching", "Caching stores values in memory.");
    const before = await fingerprintTree(root);

    const counts = await reviewArticle(root);

    await expectNoContact(root, before);
    expect(describeLinkReview(counts)).toBeNull();
  });
});
