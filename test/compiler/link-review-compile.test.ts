/**
 * @file test/compiler/link-review-compile.test.ts
 * @description The reference review measured at the PIPELINE level (S9, S12): the
 * compile reaches the stage, the stage's bounds hold, and a compile with nothing to
 * do writes no page at all.
 *
 * WHY THE ENTRY POINT IS THE WHOLE POINT. This file previously asserted only that a
 * quiet compile prints no `Link review` line -- and it passed while the stage had NO
 * call site at all, because a stage that never runs cannot print. The first case below
 * therefore makes the compile ADD a curated link to an earlier page, which only
 * happens when `finalizeWiki` really invokes the stage: unwire it and this file goes
 * red. The quiet cases stay, now as evidence that the wired stage is a no-op when the
 * wiki has nothing to review, not as evidence that it is unreachable.
 *
 * THE ANCHOR IS AN ALIAS, DELIBERATELY. The resolver re-wraps plain mentions of page
 * TITLES on every render, so a title-anchored link would appear here even with the
 * stage dead. An alias mention has no passive channel behind it: if the link exists,
 * the stage wrote it. This asymmetry is the reason the earlier "casual" checks of this
 * file looked green.
 *
 * Driven through `compileAndReport`, the public compile entry point, with the provider
 * stubbed, so no network and no key are involved.
 */

import { describe, it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { declareAlias, readConceptPage } from "../fixtures/concept-page.js";
import { stubCompileProvider } from "../fixtures/compile-provider.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";
import { captureProcessIo, type CapturedProcessIo } from "../fixtures/process-io.js";

/** The source whose page MENTIONS the target by an alias, never by its title. */
const ALPHA_SOURCE = "alpha.md";

/** The source whose article is the link TARGET, titled `Vector DB`. */
const BETA_SOURCE = "beta.md";

/** Marker that routes the extraction stub to the beta source. */
const BETA_MARKER = "BETA SOURCE TEXT";

/**
 * The alias alpha mentions.
 *
 * Distinct from the title AND from the title's canonical key, so this case measures
 * the pipeline wiring and not the alias-dedupe rule that `link-review.test.ts` owns.
 */
const TARGET_ALIAS = "pgvector store";

/** Alpha's body: names the target only through its declared alias. */
const ALPHA_BODY = "A pgvector store keeps embeddings. ^[alpha.md]";

/** Beta's body: the target article itself. */
const BETA_BODY = "Vector DB keeps embeddings for retrieval. ^[beta.md]";

/** Alpha's body when the case is about the gate rather than the review: two real
 * mentions of ONE target in one section, which the redundancy rule has to settle. */
const ALPHA_BODY_TWO_TARGETS = "Alpha Topic compares with Vector DB. Vector DB again. ^[alpha.md]";

/** Extraction payload naming one concept. */
function extractionFor(title: string): string {
  return JSON.stringify({ concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }] });
}

/**
 * Stub the provider: extraction routes on the SOURCE TEXT, page rendering returns each
 * page's fixed body, and the review accepts the alias mention.
 *
 * Extraction must route on source text rather than on a title, because the extraction
 * prompt also carries the existing wiki index and therefore every title compiled so far.
 *
 * @param reviewAccepted - Whether the review verdict links the mention.
 * @param alphaBody - Alpha's rendered body, for the case that measures the link gate.
 */
function stubProvider(reviewAccepted = true, alphaBody = ALPHA_BODY): void {
  stubCompileProvider({
    extraction: (system) => extractionFor(system.includes(BETA_MARKER) ? "Vector DB" : "Alpha Topic"),
    body: (system) => (system.includes('Concept to write about: "Vector DB"') ? BETA_BODY : alphaBody),
    review: () => JSON.stringify({ should_link: reviewAccepted, mention: TARGET_ALIAS }),
  });
}

/** Write the source corpus of a two-concept project. */
async function writeSources(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", ALPHA_SOURCE), `# Alpha Topic\n\n${ALPHA_BODY}\n`, "utf-8");
  await writeFile(
    path.join(root, "sources", BETA_SOURCE),
    `# Vector DB\n\n${BETA_MARKER}. Vector DB keeps embeddings.\n`,
    "utf-8",
  );
}

/**
 * Revise the beta source and compile it, which re-renders ONLY the target article.
 *
 * Alpha's source is untouched by this, so the review of earlier pages is the only thing
 * that can change alpha's page in the run this returns.
 *
 * @param root - Project root.
 * @returns The run's captured output.
 */
async function reviseAndCompile(root: string): Promise<CapturedProcessIo> {
  await writeFile(
    path.join(root, "sources", BETA_SOURCE),
    `# Vector DB\n\n${BETA_MARKER}, revised. Vector DB keeps embeddings.\n`,
    "utf-8",
  );
  const io = captureProcessIo();
  await compileAndReport(root);
  return io;
}

describe("link review at the pipeline level", () => {
  const ctx = useCompileProject({ dirSuffix: "link-review-compile", sourceFile: ALPHA_SOURCE });

  it("W1 the compile reviews an earlier page and links its alias mention", async () => {
    await writeSources(ctx.dir);
    stubProvider();
    await compileAndReport(ctx.dir);
    expect(await readConceptPage(ctx.dir, "alpha-topic")).toContain(TARGET_ALIAS);
    await declareAlias(ctx.dir, "vector-db", TARGET_ALIAS);

    // A second compile of the beta source alone: alpha's source is untouched, so the
    // ONLY thing that can add a link to alpha's page is the review of earlier pages.
    const io = await reviseAndCompile(ctx.dir);

    expect(await readConceptPage(ctx.dir, "alpha-topic")).toContain(`[[vector-db|${TARGET_ALIAS}]]`);
    expect(io.out()).toContain("Link review of earlier pages: 1 review(s) of 1 earlier page(s)");
  });

  it("W2 writes no page at all when a compile finds nothing to do", async () => {
    await writeSources(ctx.dir);
    stubProvider();
    await compileAndReport(ctx.dir);
    const before = await fingerprintTree(path.join(ctx.dir, "wiki/concepts"));
    expect(before.size).toBeGreaterThan(0);

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    expect(changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki/concepts")))).toEqual([]);
    expect(io.out()).not.toContain("Link review");
  });

  it("W4 the compile's link gate demotes a redundant link and reports it", async () => {
    await writeSources(ctx.dir);
    stubProvider(true, ALPHA_BODY_TWO_TARGETS);

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    // Both mentions of the target are real anchors, and the resolver wraps both. The
    // gate is what refuses the second in the same section, and its run total reaches the
    // operator -- so this case proves the gate DECIDES inside a compile, not merely that
    // the resolver function exists.
    expect(io.out()).toContain("Contextual links in this run: 1 kept, 1 demoted (1 redundant).");
    const alpha = await readConceptPage(ctx.dir, "alpha-topic");
    expect([...alpha.matchAll(/\[\[vector-db/g)]).toHaveLength(1);
    expect(alpha).toContain("Vector DB again.");
  });

  it("W3 leaves an earlier page byte-identical when a refused verdict arrives", async () => {
    await writeSources(ctx.dir);
    stubProvider(false);
    await compileAndReport(ctx.dir);
    await declareAlias(ctx.dir, "vector-db", TARGET_ALIAS);
    const earlier = await readConceptPage(ctx.dir, "alpha-topic");

    const io = await reviseAndCompile(ctx.dir);

    // The stage reached the model and the model said no: a refusal changes no byte.
    expect(await readConceptPage(ctx.dir, "alpha-topic")).toBe(earlier);
    expect(io.out()).toContain("Link review of earlier pages: 1 review(s) of 1 earlier page(s)");
    expect(io.out()).toContain("0 link(s) added in 0 page(s)");
  });
});
