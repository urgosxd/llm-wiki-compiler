/**
 * @file test/compiler/synthesis-provenance.test.ts
 * @description Multi-source synthesis measured on the COMPILE path: one concept is one
 * article, that article attributes each of its contributing sources, and the original
 * sources are left exactly as they were ingested (S2, S3, S7, S12).
 *
 * WHY THE COMPILE ENTRY POINT IS THE WHOLE POINT. `mergeExtractions` collecting
 * `sourceFiles` and the frontmatter carrying `sources` prove only that a page LISTS its
 * sources; they say nothing about whether its PROSE attributes a claim to each of them.
 * A merged article can therefore claim two sources and cite one, which is the
 * concatenation-without-attribution defect S2 forbids. Every case below drives
 * `compileAndReport`, so the assertion is about what a real run leaves on disk and prints,
 * not about what an internal helper returns.
 *
 * WHAT EACH CASE PROTECTS.
 *  - Q1 two sources covering ONE concept produce exactly one page whose `sources` names
 *    both -- never one page per source;
 *  - Q2 that page's body carries attribution for each contributing source, in the
 *    repository's own `^[file.md:lines]` convention, and a merged body that attributes
 *    only one of them is REPORTED by name instead of passing quietly;
 *  - Q3 the files under `sources/` are byte-identical before and after the compile;
 *  - Q4 a single-source concept still renders and cites its one source (regression pin);
 *  - Q5 a later ingest of an overlapping source keeps ONE page and does not duplicate
 *    the `sources` entries it already had;
 *  - Q6 a prompt budget that truncates merged material is reported, not silent.
 *
 * The provider is stubbed (no network, no key) and every project lives in a throwaway
 * directory under the OS temp dir that the fixture removes afterwards.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { listConceptPages, readConceptPage } from "../fixtures/concept-page.js";
import { extractionAnswer, stubCompileProvider } from "../fixtures/compile-provider.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { BETA, BETA_SOURCE, addBetaSource } from "../fixtures/synthesis-scenario.js";

/** The source the fixture project starts with. */
const ALPHA = "alpha.md";

/** Alpha's whole text: short on purpose, so a budget case can force truncation. */
const ALPHA_SOURCE = "# Append-only log\n\nAlpha says the log is append-only.\n";

/** The one concept both sources substantiate: the merged article's slug. */
const CONCEPT = "Vector DB";

/** The concept a single-source case keeps separate from the merged one. */
const SOLO_CONCEPT = "Append Only Log";

/** Both sources attributed, in the `^[a.md:lines, b.md:lines]` form the prompt names. */
const FULL_BODY = `${CONCEPT} merges both accounts. ^[${ALPHA}:1-1, ${BETA}:1-1]`;

/** The same merged article with beta's contribution attributed to nobody. */
const ALPHA_ONLY_BODY = `${CONCEPT} follows Alpha. ^[${ALPHA}:1-1]`;

/** The line the compile prints when a merged article leaves a source unattributed. */
const GAP_LINE = `Page "${CONCEPT}" merges 2 source(s) but attributes 1: ` +
  `no statement is attributed to ${BETA}.`;

afterEach(() => {
  delete process.env.LLMWIKI_PROMPT_BUDGET_CHARS;
});

/**
 * Stub the compile's provider calls: ONE concept extracted from whichever source is
 * read, and one fixed rendered body.
 *
 * Extraction answers the same title for both sources on purpose -- that is what makes
 * the two of them contributors to ONE concept instead of two.
 *
 * @param body - The body every page render returns.
 * @param title - The concept every extraction names.
 */
function stubSynthesis(body: string, title: string = CONCEPT): void {
  stubCompileProvider({
    extraction: () => extractionAnswer([title]),
    body: () => body,
  });
}

/** The `sources` frontmatter of one page, sorted so arrival order cannot mask a gap. */
async function sourcesOf(root: string, slug: string): Promise<string[]> {
  const { meta } = parseFrontmatter(await readConceptPage(root, slug));
  const sources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  return [...sources].sort();
}

/** Assert the wiki holds exactly ONE page for the merged concept, naming both sources. */
async function expectOneMergedPage(root: string): Promise<void> {
  expect(await listConceptPages(root)).toEqual(["vector-db.md"]);
  expect(await sourcesOf(root, "vector-db")).toEqual([ALPHA, BETA]);
}

describe("multi-source synthesis", () => {
  const ctx = useCompileProject({
    dirSuffix: "synthesis-provenance",
    sourceFile: ALPHA,
    sourceContent: ALPHA_SOURCE,
  });

  it("Q1 two sources covering one concept produce exactly ONE page listing both", async () => {
    stubSynthesis(FULL_BODY);
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    await expectOneMergedPage(ctx.dir);
  });

  it("Q2 the merged page attributes each contributing source in the wiki's citation form", async () => {
    const io = captureProcessIo();
    stubSynthesis(FULL_BODY);
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    expect(await readConceptPage(ctx.dir, "vector-db")).toContain(`^[${ALPHA}:1-1, ${BETA}:1-1]`);
    expect(io.out()).not.toContain("no statement is attributed to");
  });

  it("Q2 reports a merged page that attributes only one of its contributing sources", async () => {
    const io = captureProcessIo();
    stubSynthesis(ALPHA_ONLY_BODY);
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    expect(io.out()).toContain(GAP_LINE);
  });

  it("Q3 leaves both source files byte-identical and the page pointing at them", async () => {
    stubSynthesis(FULL_BODY);
    await addBetaSource(ctx.dir);
    const alphaBefore = await readFile(path.join(ctx.dir, "sources", ALPHA));
    const betaBefore = await readFile(path.join(ctx.dir, "sources", BETA));

    await compileAndReport(ctx.dir);

    expect(await readFile(path.join(ctx.dir, "sources", ALPHA))).toEqual(alphaBefore);
    expect(await readFile(path.join(ctx.dir, "sources", BETA))).toEqual(betaBefore);
    await expectOneMergedPage(ctx.dir);
  });

  it("Q4 a concept covered by ONE source still renders and cites that source", async () => {
    const io = captureProcessIo();
    stubSynthesis(`${SOLO_CONCEPT} records one account. ^[${ALPHA}:1-1]`, SOLO_CONCEPT);

    await compileAndReport(ctx.dir);

    expect(await listConceptPages(ctx.dir)).toEqual(["append-only-log.md"]);
    expect(await readConceptPage(ctx.dir, "append-only-log")).toContain(`^[${ALPHA}:1-1]`);
    expect(await sourcesOf(ctx.dir, "append-only-log")).toEqual([ALPHA]);
    expect(io.out()).not.toContain("no statement is attributed to");
  });

  it("Q5 a later ingest of an overlapping source keeps ONE page and no duplicate source", async () => {
    stubSynthesis(FULL_BODY);
    await compileAndReport(ctx.dir);
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    await expectOneMergedPage(ctx.dir);
  });

  it("Q6 a budget that truncates merged material is reported instead of silent", async () => {
    process.env.LLMWIKI_PROMPT_BUDGET_CHARS = "40";
    const io = captureProcessIo();
    stubSynthesis(FULL_BODY);
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    const raw = (ALPHA_SOURCE.length + BETA_SOURCE.length).toLocaleString();
    expect(io.out()).toContain(
      `Combined source content for "${CONCEPT}" (${raw} chars across 2 sources) exceeds the ` +
        `40-char prompt budget; truncating each source to ~20 chars.`,
    );
  });
});
