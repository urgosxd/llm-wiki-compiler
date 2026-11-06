/**
 * @file test/compiler/wiki-stability.test.ts
 * @description What a RE-INGEST does to the wiki a previous ingest built: does a
 * curated link survive, is a no-op run byte-stable, and is a prompt-generation change
 * visible (S9, S12, S13).
 *
 * WHY THIS FILE EXISTS. Every contextual link the reference review adds is written
 * into the target page's GENERATED BODY: `link-review.ts` edits one span and saves the
 * page. A body is produced wholesale by the model, so nothing outside those bytes
 * records that the link was ever curated. These cases MEASURE that design instead of
 * assuming it, so a fix is built against observed behaviour.
 *
 * THE TWO ANCHOR FORMS ARE NOT EQUAL. A mention of the target's TITLE is re-wrapped by
 * the resolver on every render of the page (`resolver.ts` `addWikilinks` iterates page
 * titles only), so a title-anchored link comes back by itself. A mention of an ALIAS is
 * never re-wrapped, so an alias-anchored link exists only in the bytes the review wrote.
 * Every curation case below therefore anchors on an alias: it is the form with no
 * passive channel behind it.
 *
 * PROBE, NOT POLICY. A case that records a defect the pending durable-curated-link
 * record must fix is marked `test.fails` with the defect named above it, which turns
 * the suite red the moment the defect is fixed. A case that records behaviour that is
 * correct, or merely surprising but not a defect, is a normal passing test.
 *
 * The provider is stubbed (no network, no key) and every project lives in a throwaway
 * directory under the OS temp dir, removed by the fixture afterwards.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { compileAndReport } from "../../src/compiler/index.js";
import { reviewEarlierPages } from "../../src/compiler/link-review.js";
import { PROMPT_VERSION } from "../../src/compiler/prompts.js";
import { buildFrontmatter, parseFrontmatter } from "../../src/utils/markdown.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";
import { captureProcessIo, type CapturedProcessIo } from "../fixtures/process-io.js";

/** Source whose ingest creates the article that later gains a curated link. */
const ALPHA_SOURCE = "alpha.md";

/** Source whose ingest creates the LINK TARGET, titled `Vector DB`. */
const BETA_SOURCE = "beta.md";

/** Marker that routes the extraction stub to the beta source. */
const BETA_MARKER = "BETA SOURCE TEXT";

/** An alias whose canonical key differs from the title's, declared in frontmatter. */
const DECLARED_ALIAS = "pgvector store";

/** The alias the identity stage folds from beta's two spellings. */
const MERGED_ALIAS = "Vector Database";

/** Alpha's body: names the target by its DECLARED alias, never by its title. */
const ALPHA_BODY = "Alpha Topic stores vectors in a pgvector store. ^[alpha.md]";

/** Alpha's body: names the target by the alias the identity fold produced. */
const ALPHA_BODY_MERGED_NAME = "Alpha Topic stores vectors in a Vector Database. ^[alpha.md]";

/** Alpha's body once the mention that justified the curated link is gone. */
const ALPHA_BODY_WITHOUT_TARGET = "Alpha Topic stores vectors only. ^[alpha.md]";

/** Beta's body: the target article itself. */
const BETA_BODY = "Vector DB keeps embeddings for retrieval. ^[beta.md]";

/** A page compiled under an OLDER prompt generation, seeded to simulate history. */
const LEGACY_PAGE = [
  "---",
  "title: Legacy Note",
  "summary: Written by an older prompt generation.",
  "sources:",
  "  - legacy.md",
  "kind: concept",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "modelId: claude-sonnet-4-6",
  "promptVersion: v1",
  "---",
  "",
  "A page nobody recompiled.",
  "",
].join("\n");

/** Extraction payload naming one concept. */
function extractionFor(title: string): string {
  return JSON.stringify({
    concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }],
  });
}

/**
 * Beta's extraction: ONE concept under two spellings the canonical key folds.
 *
 * This is how a page legitimately acquires an alias. `Vector Database` folds into
 * `Vector DB`, so the page's title stays `Vector DB` while its frontmatter declares
 * the other name.
 */
function betaExtraction(): string {
  return JSON.stringify({
    concepts: [
      { concept: "Vector DB", summary: "Vector storage.", is_new: true, confidence: 0.9 },
      { concept: MERGED_ALIAS, summary: "Vector storage.", is_new: false, confidence: 0.5 },
    ],
  });
}

/** What the review's model stub answers for one case. */
interface Verdict {
  /** The words the verdict claims to have judged. */
  mention: string;
}

/**
 * Stub the two structured calls the pipeline makes, plus page rendering.
 *
 * Extraction routes on the source TEXT, because the extraction prompt also carries the
 * existing wiki index and therefore every title compiled so far.
 *
 * @param alphaBody - Alpha's body for each successive render, so a case can make the
 *   model drop the mention the curated link was anchored on.
 * @param verdict - What the reference review answers.
 */
function stubProvider(alphaBody: () => string, verdict: Verdict): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (system: string, _messages, tools) => {
      if (tools[0]?.name === "judge_reference") {
        return JSON.stringify({ should_link: true, mention: verdict.mention });
      }
      return system.includes(BETA_MARKER) ? betaExtraction() : extractionFor("Alpha Topic");
    },
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(
    async (system: string) => {
      return system.includes('Concept to write about: "Vector DB"') ? BETA_BODY : alphaBody();
    },
  );
}

/** Write one source file, replacing whatever was there. */
async function writeSource(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", file), content, "utf-8");
}

/** The full markdown of one concept page. */
async function readPage(root: string, slug: string): Promise<string> {
  return await readFile(path.join(root, "wiki/concepts", `${slug}.md`), "utf-8");
}

/**
 * Add one declared alias to a page's frontmatter.
 *
 * `aliases` is a supported frontmatter field that the identity stage persists and the
 * review stage reads, and it is the only form of alias whose canonical key can differ
 * from the title's -- which is the form the review stage exists to honour.
 *
 * @param root - Project root.
 * @param slug - Page to edit.
 * @param alias - Name to declare.
 */
async function declareAlias(root: string, slug: string, alias: string): Promise<void> {
  const { meta, body } = parseFrontmatter(await readPage(root, slug));
  const declared = Array.isArray(meta.aliases) ? meta.aliases : [];
  const fields = { ...meta, aliases: [...declared.map(String), alias] };
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), `${buildFrontmatter(fields)}\n\n${body}\n`, "utf-8");
}

/**
 * Ingest alpha, then beta -- creating the article and its folded alias -- then declare
 * the second alias the curation cases anchor on.
 *
 * @param root - Project root.
 * @param alphaBody - Alpha's body for each successive render.
 * @param verdict - The review model's answer.
 * @returns The beta ingest's captured output.
 */
async function ingestBoth(
  root: string,
  alphaBody: () => string = () => ALPHA_BODY,
  verdict: Verdict = { mention: DECLARED_ALIAS },
): Promise<CapturedProcessIo> {
  stubProvider(alphaBody, verdict);
  await writeSource(root, ALPHA_SOURCE, `# Alpha Topic\n\n${ALPHA_BODY}\n`);
  await compileAndReport(root);
  await writeSource(root, BETA_SOURCE, `# Vector DB\n\n${BETA_MARKER}. Vector DB keeps embeddings.\n`);
  const io = captureProcessIo();
  await compileAndReport(root);
  await declareAlias(root, "vector-db", DECLARED_ALIAS);
  return io;
}

/** Re-ingest alpha alone, with a source revision that changes nothing else. */
async function reingestAlpha(root: string): Promise<void> {
  await writeSource(root, ALPHA_SOURCE, `# Alpha Topic\n\n${ALPHA_BODY} Revised.\n`);
  await compileAndReport(root);
}

/** An index body with the run's own generation stamp blanked out. */
function withoutRunStamp(markdown: string): string {
  return markdown.replace(/Generated [0-9TZ:.:-]+/g, "Generated <stamp>");
}

describe("wiki stability across ingests", () => {
  const ctx = useCompileProject({ dirSuffix: "wiki-stability", sourceFile: ALPHA_SOURCE });

  // DEFECT: the reference review is not wired into the pipeline. `reviewEarlierPagesForRun`
  // (`src/compiler/index.ts:1272`) has NO call site, so no compile ever reviews an earlier
  // page and no curated link exists in a real wiki. Pending fix: call it from `finalizeWiki`.
  it.fails("S-A1 the compile adds the curated link when it ingests the target article", async () => {
    await ingestBoth(ctx.dir);
    expect(await readPage(ctx.dir, "vector-db")).toContain("title: Vector DB");
    expect(await readPage(ctx.dir, "alpha-topic")).toContain(`[[vector-db|${DECLARED_ALIAS}]]`);
  });

  // DEFECT: retrieval drops the alias it needs. `extraNames`
  // (`src/compiler/link-review-candidates.ts:222-235`) dedupes an article's names by
  // CANONICAL KEY while the mention scan matches them LITERALLY (`firstPlainMention`,
  // same file, line 282), so an alias that differs from the title only by
  // canonicalisation -- the only kind a NAME RULE fold produces -- is discarded.
  // Pending fix: dedupe on the literal spelling, not the canonical key.
  it.fails("S-A1 reviews a page that names the article by its folded alias", async () => {
    await ingestBoth(ctx.dir, () => ALPHA_BODY_MERGED_NAME, { mention: MERGED_ALIAS });
    const counts = await reviewEarlierPages(ctx.dir, [
      { slug: "vector-db", title: "Vector DB", aliases: [MERGED_ALIAS] },
    ]);
    expect(counts.reviewed).toBe(1);
    expect(counts.linksAdded).toBe(1);
  });

  // DEFECT: a curated link lives only in generated bytes. The next render of the page it
  // sits on replaces the whole body, and no channel re-adds an ALIAS-anchored link. Pending
  // fix: a durable curated-link record plus a render-time overlay.
  it.fails("S-A1 a curated link survives a re-ingest of the page that carries it", async () => {
    await ingestBoth(ctx.dir);
    expect((await reviewEarlierPages(ctx.dir, [
      { slug: "vector-db", title: "Vector DB", aliases: [DECLARED_ALIAS] },
    ])).linksAdded).toBe(1);
    expect(await readPage(ctx.dir, "alpha-topic")).toContain(DECLARED_ALIAS);

    await reingestAlpha(ctx.dir);
    expect(await readPage(ctx.dir, "alpha-topic")).toContain(`[[vector-db|${DECLARED_ALIAS}]]`);
  });

  it("S-A1 measures the ping-pong: the link returns only when the target is reviewed", async () => {
    const article = { slug: "vector-db", title: "Vector DB", aliases: [DECLARED_ALIAS] };
    await ingestBoth(ctx.dir);
    await reviewEarlierPages(ctx.dir, [article]);
    expect(await readPage(ctx.dir, "alpha-topic")).toContain(`[[vector-db|${DECLARED_ALIAS}]]`);

    await reingestAlpha(ctx.dir);
    expect(await readPage(ctx.dir, "alpha-topic")).not.toContain("[[vector-db");

    // Reviewing the SAME article again puts the link back: the mention it anchors on is
    // still in the text. Presence is a function of which article was ingested last.
    await reviewEarlierPages(ctx.dir, [article]);
    expect(await readPage(ctx.dir, "alpha-topic")).toContain(`[[vector-db|${DECLARED_ALIAS}]]`);
  });

  it("S-A2 a compile of unchanged sources changes no page and no ordering", async () => {
    await ingestBoth(ctx.dir);
    const before = await fingerprintTree(ctx.dir);
    const indexBefore = withoutRunStamp(await readFile(path.join(ctx.dir, "wiki/index.md"), "utf-8"));

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    const after = await fingerprintTree(ctx.dir);
    const pages = changedPaths(before, after).filter((file) => file.startsWith("wiki/concepts"));
    expect(pages).toEqual([]);
    expect(io.out()).toContain("Nothing to compile");
    expect(withoutRunStamp(await readFile(path.join(ctx.dir, "wiki/index.md"), "utf-8")))
      .toBe(indexBefore);
  });

  it("S-A2 names the artifact a no-op compile still rewrites", async () => {
    await ingestBoth(ctx.dir);
    const before = await fingerprintTree(ctx.dir);
    await compileAndReport(ctx.dir);
    // `.llmwiki/` holds the compile's own bookkeeping, not wiki content; its
    // pending-embeddings marker churns here only because this run has no embedding key.
    const changed = changedPaths(before, await fingerprintTree(ctx.dir))
      .filter((file) => !file.startsWith(".llmwiki/"));
    expect(changed).toEqual(["wiki/index.md"]);
  });

  it("S-A3 loses the link silently when its anchor leaves the regenerated body", async () => {
    let renders = 0;
    await ingestBoth(ctx.dir, () => (renders++ === 0 ? ALPHA_BODY : ALPHA_BODY_WITHOUT_TARGET));
    const article = { slug: "vector-db", title: "Vector DB", aliases: [DECLARED_ALIAS] };
    expect((await reviewEarlierPages(ctx.dir, [article])).linksAdded).toBe(1);

    await reingestAlpha(ctx.dir);
    const io = captureProcessIo();
    const counts = await reviewEarlierPages(ctx.dir, [article]);

    const page = await readPage(ctx.dir, "alpha-topic");
    expect(page).not.toContain(DECLARED_ALIAS);
    expect(page).not.toContain("[[vector-db");
    // No anchor, no candidate: the link cannot even be re-proposed, and the run that
    // destroyed it said nothing about it.
    expect(counts.reviewed).toBe(0);
    expect(counts.linksAdded).toBe(0);
    expect(io.out()).not.toContain("Link review");
  });

  it("S-A4 leaves pages of an older prompt generation untouched and unmentioned", async () => {
    await ingestBoth(ctx.dir);
    await writeFile(path.join(ctx.dir, "wiki/concepts/legacy-note.md"), LEGACY_PAGE, "utf-8");

    const io = captureProcessIo();
    await reingestAlpha(ctx.dir);

    const legacy = await readPage(ctx.dir, "legacy-note");
    expect(legacy).toBe(LEGACY_PAGE);
    expect(legacy).toContain("promptVersion: v1");
    // The recompiled page carries the CURRENT generation, so the wiki now holds two
    // generations at once and the run reported neither.
    expect(await readPage(ctx.dir, "alpha-topic")).toContain(`promptVersion: ${PROMPT_VERSION}`);
    expect(io.out()).not.toContain("promptVersion");
  });
});
