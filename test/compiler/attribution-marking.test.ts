/**
 * @file test/compiler/attribution-marking.test.ts
 * @description A page that is NOT fully attributed is never PRESENTED as fully
 * attributed: the compiled page carries the gap in its own frontmatter, the run prints
 * one counted line naming every page and source, and the compile summary repeats the
 * count so the headline is true on its own (S2, S7, S12).
 *
 * WHY THE PAGE ITSELF HAS TO CARRY IT. The per-page warning T7 added tells the OPERATOR
 * of one run that a merged article cited only some of its sources, and the compiled page
 * then looks exactly like a fully attributed one: its `sources` list names both, and
 * nothing in the stored bytes says the prose attributed only one. A reader of the wiki,
 * a consumer of the export or a host that replays the corpus months later has no way to
 * tell the two apart. The Manager's rule is that a page which is not fully attributed is
 * never presented AS fully attributed, so the gap is marked where the page is:
 *
 *   attributionGaps: [beta.md]     (frontmatter, omitted entirely when there is no gap)
 *   Attribution: 1 page(s) not fully attributed (1 source reference(s) missing) — ... is missing ...
 *   Attribution summary: 1 page(s) of this run not fully attributed (1 source reference(s) missing).
 *
 * THE PAGE IS STILL WRITTEN. The marker reports; it never holds a page back, because
 * discarding content nobody asked to lose is worse than a page carrying an honest note.
 *
 * WHAT EACH CASE PROTECTS.
 *  - T1 a merged page that attributes one of its two sources carries the field listing
 *    exactly the missing source, prints the counted line naming page and source, and the
 *    run counts ONE page;
 *  - T2 a fully attributed merged page has NO field and prints no attribution line;
 *  - T3 a single-source page is unchanged and carries no field;
 *  - T4 the count aggregates across two imperfect pages, in page-name order;
 *  - T5 the marked page is still written and still parses and renders;
 *  - T6 the compile summary mentions the incompleteness.
 *
 * Every case drives `compileAndReport`, so each assertion is about what a real run leaves
 * on disk and prints. The provider is stubbed (no network, no key) and every project
 * lives in a throwaway directory under the OS temp dir that the fixture removes.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { parseFrontmatter, parseFrontmatterStatus } from "../../packages/wiki/src/utils/markdown.js";
import { CONCEPTS_DIR } from "../../packages/wiki/src/utils/constants.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { listConceptPages, readConceptPage } from "../fixtures/concept-page.js";
import { extractionAnswer, stubCompileProvider } from "../fixtures/compile-provider.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { BETA, addBetaSource } from "../fixtures/synthesis-scenario.js";

/** The source the fixture project starts with. */
const ALPHA = "alpha.md";

/** Alpha's text. */
const ALPHA_SOURCE = "# Append-only log\n\nAlpha says the log is append-only.\n";

/** The concept both sources substantiate: the merged article's slug. */
const CONCEPT = "Vector DB";

/** The concept a single-source case keeps its own page for. */
const SOLO_CONCEPT = "Append Only Log";

/** The merged body that attributes BOTH contributing sources. */
const FULL_BODY = `${CONCEPT} merges both accounts. ^[${ALPHA}:1-1, ${BETA}:1-1]`;

/** The merged body that attributes alpha only, leaving beta's account untraced. */
const ALPHA_ONLY_BODY = `${CONCEPT} follows Alpha. ^[${ALPHA}:1-1]`;

/** The second merged article's body, which attributes beta only. */
const BETA_ONLY_BODY = `${SOLO_CONCEPT} follows Beta. ^[${BETA}:1-1]`;

/** The counted detail line for ONE imperfect page, exactly as the run prints it. */
const ONE_PAGE_LINE = "Attribution: 1 page(s) not fully attributed (1 source reference(s) " +
  `missing) — ${CONCEPT} is missing ${BETA}`;

/** The summed detail line for TWO imperfect pages, in page-name order. */
const TWO_PAGE_LINE = "Attribution: 2 page(s) not fully attributed (2 source reference(s) " +
  `missing) — ${SOLO_CONCEPT} is missing ${ALPHA}; ${CONCEPT} is missing ${BETA}`;

/** The compile-summary mention, which repeats the count without the page detail. */
const ONE_PAGE_SUMMARY = "Attribution summary: 1 page(s) of this run not fully attributed " +
  "(1 source reference(s) missing).";

/**
 * Stub the compile's provider: the given concepts from every source, and a body chosen
 * from the concept the render prompt names.
 *
 * It routes on the prompt's own `Concept to write about: "<name>".` line rather than on a
 * bare mention of the title, because the SOURCE MATERIAL a merged page is given contains
 * the other article's title -- a substring test would answer for the wrong page.
 *
 * @param bodies - Rendered body per concept title.
 * @param titles - Concept titles every extraction returns.
 */
function stubAttribution(
  bodies: Readonly<Record<string, string>>,
  titles: readonly string[] = [CONCEPT],
): void {
  stubCompileProvider({
    extraction: () => extractionAnswer(titles),
    body: (system) => {
      const title = Object.keys(bodies).find((name) =>
        system.includes(`Concept to write about: "${name}"`));
      return title === undefined ? "" : bodies[title];
    },
  });
}

/** Assert the stored page records EXACTLY the given unattributed sources. */
async function expectGaps(root: string, slug: string, missing: string[]): Promise<void> {
  const { meta } = parseFrontmatter(await readConceptPage(root, slug));
  expect(meta.attributionGaps).toEqual(missing);
}

describe("attribution marking", () => {
  const ctx = useCompileProject({
    dirSuffix: "attribution-marking",
    sourceFile: ALPHA,
    sourceContent: ALPHA_SOURCE,
  });

  it("T1 a merged page that attributes one source marks the one it leaves out", async () => {
    const io = captureProcessIo();
    stubAttribution({ [CONCEPT]: ALPHA_ONLY_BODY });
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    await expectGaps(ctx.dir, "vector-db", [BETA]);
    expect(io.out()).toContain(ONE_PAGE_LINE);
  });

  it("T2 a fully attributed merged page has no field and prints no attribution line", async () => {
    const io = captureProcessIo();
    stubAttribution({ [CONCEPT]: FULL_BODY });
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    const page = await readConceptPage(ctx.dir, "vector-db");
    const { meta } = parseFrontmatter(page);
    expect(page).not.toContain("attributionGaps");
    expect(meta.title).toBe(CONCEPT);
    expect([...(meta.sources as string[])].sort()).toEqual([ALPHA, BETA]);
    expect(io.out()).not.toContain("Attribution");
  });

  it("T3 a single-source page is unchanged and carries no field", async () => {
    const io = captureProcessIo();
    stubAttribution({ [SOLO_CONCEPT]: `${SOLO_CONCEPT} records one account. ^[${ALPHA}:1-1]` },
      [SOLO_CONCEPT]);

    await compileAndReport(ctx.dir);

    const page = await readConceptPage(ctx.dir, "append-only-log");
    expect(page).not.toContain("attributionGaps");
    expect(page).toContain(`^[${ALPHA}:1-1]`);
    expect(parseFrontmatter(page).meta.sources).toEqual([ALPHA]);
    expect(io.out()).not.toContain("Attribution");
    expect(io.out()).not.toContain("no statement is attributed to");
  });

  it("T4 the count aggregates across two imperfect pages", async () => {
    const io = captureProcessIo();
    stubAttribution({ [CONCEPT]: ALPHA_ONLY_BODY, [SOLO_CONCEPT]: BETA_ONLY_BODY },
      [CONCEPT, SOLO_CONCEPT]);
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    await expectGaps(ctx.dir, "vector-db", [BETA]);
    await expectGaps(ctx.dir, "append-only-log", [ALPHA]);
    expect(io.out()).toContain(TWO_PAGE_LINE);
  });

  it("T5 the marked page is still written and still parses and renders", async () => {
    stubAttribution({ [CONCEPT]: ALPHA_ONLY_BODY });
    await addBetaSource(ctx.dir);

    const result = await compileAndReport(ctx.dir);

    expect(result.pages).toEqual(["vector-db"]);
    const page = await readConceptPage(ctx.dir, "vector-db");
    const { meta, body, hasFrontmatterBlock, malformedFrontmatter } =
      parseFrontmatterStatus(page);
    expect(hasFrontmatterBlock).toBe(true);
    expect(malformedFrontmatter).toBe(false);
    expect(meta.attributionGaps).toEqual([BETA]);
    expect([...(meta.sources as string[])].sort()).toEqual([ALPHA, BETA]);
    expect(body).toContain(ALPHA_ONLY_BODY);
    expect(await listConceptPages(ctx.dir)).toEqual(["vector-db.md"]);
  });

  it("T6 the compile summary mentions the incompleteness", async () => {
    const io = captureProcessIo();
    stubAttribution({ [CONCEPT]: ALPHA_ONLY_BODY });
    await addBetaSource(ctx.dir);

    await compileAndReport(ctx.dir);

    expect(io.out()).toContain(ONE_PAGE_SUMMARY);
  });
});
