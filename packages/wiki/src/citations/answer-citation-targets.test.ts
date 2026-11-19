/**
 * Citation targets produced by the `query_wiki` answer path, driven end to end.
 *
 * WHAT THE SYSTEM DOES (every locator below was read while writing this file):
 * - A page IS `(page_directory, slug)` — `packages/wiki/src/dimensions/wiki/schema.sql:71`
 *   with `primary key (stack_id, page_directory, slug)` at `:106`.
 * - `collectAnswerCitationIndex` mints the qualified identity `${pageDirectory}/${slug}`
 *   at `packages/wiki/src/citations/answer-index.ts:36` from the RAW filename stem
 *   (`:33`), so `concepts` + `test2` becomes the id `concepts/test2`.
 * - The answering model is shown those qualified ids as grounding headers
 *   (`packages/wiki/src/commands/query.ts:269`, `--- Page: ${pageId} ---`) and told to
 *   cite with wikilinks (`:81`). The citation it emits for a page is therefore that
 *   same qualified id, which is exactly the form reported in production.
 * - `recognizedWikilinkTargets` normalizes every wikilink target before resolution
 *   (`packages/wiki/src/wiki/wikilink-tokens.ts:53` -> `normalizeWikilinkTarget` at
 *   `:77`), which keeps a qualified namespace and slugifies ONLY the page part:
 *   `slugify` (`packages/wiki/src/utils/markdown.ts:69-77`) deletes `/` because `/`
 *   matches `[^\p{L}\p{N}\s-]`, so slugifying the whole target would lose the
 *   namespace entirely.
 * - `classifyAnswerCitations` resolves that normalized target through
 *   `packages/wiki/src/citations/answer-report.ts:20` -> `resolveBareSlug`
 *   (`packages/wiki/src/viewer/collect.ts:72`), which honors a namespace on a
 *   qualified target (`:82`) and matches a bare slug against the RAW filename stem
 *   both exactly and slugified, exact first (`findPageInDirectory`, `:129`), because
 *   the stored `slug` is the RAW filename stem.
 *
 * Every case below drives that production chain — real page files on disk, then
 * `collectAnswerCitationIndex`, then `reportAnswerCitations`. No target string is
 * hand-written: the cited form is taken from the identity the index itself minted,
 * or from the page title the answer prompt asks the model to cite.
 *
 * The pinned invariant is a property, not three literals: a citation target returned
 * by the answer path resolves to a page that exists in that stack.
 */
import MarkdownIt from "markdown-it";
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import os from "node:os";
import path from "node:path";
import { collectAnswerCitationIndex } from "./answer-index.js";
import { reportAnswerCitations } from "./answer-report.js";
import type { RetainedCitationTarget } from "./answer-types.js";
import { collectViewerPages, resolveBareSlug } from "../viewer/collect.js";
import { registerWikilink } from "../viewer/wikilink-rule.js";
import type { ViewerPage } from "../viewer/types.js";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) await fs.rm(created.pop() as string, { recursive: true, force: true });
});

/** Write one or more pages under one `wiki/<directory>/` and return the shared root. */
async function stackWithPages(
  directory: "concepts" | "queries",
  pages: ReadonlyArray<{ stem: string; body?: string }>,
): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answer-citation-targets-")));
  created.push(root);
  for (const page of pages) {
    const file = path.join(root, "wiki", directory, `${page.stem}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: "${page.stem}"\n---\n\n${page.body ?? `The body of ${page.stem}.`}\n`);
  }
  return root;
}

/** Write `stem` under `wiki/<directory>/` as a real page and return the project root. */
async function stackWithPage(
  directory: "concepts" | "queries",
  stem: string,
  body?: string,
): Promise<string> {
  return stackWithPages(directory, [{ stem, ...(body === undefined ? {} : { body }) }]);
}

/** The retained identity the production index minted for one page, or a readable failure. */
async function retainedIdentity(root: string, directory: string, stem: string): Promise<RetainedCitationTarget> {
  const index = await collectAnswerCitationIndex(root);
  const entry = index.retained.find((candidate) => candidate.pageDirectory === directory && candidate.slug === stem);
  if (!entry) {
    throw new Error(`page ${directory}/${stem} is on disk but the citation index does not retain it: `
      + JSON.stringify(index.retained));
  }
  return entry;
}

describe("a citation naming an existing page by its own qualified identity", () => {
  it("reproduces the production `concepts` + `test2` malformed target", async () => {
    const root = await stackWithPage("concepts", "test2");
    const page = await retainedIdentity(root, "concepts", "test2");
    // The cited form is the header the answer prompt shows this page: its qualified id.
    const report = await reportAnswerCitations(root, `Grounded in [[${page.id}]].`);

    expect(report.citations).toMatchObject([{ status: "resolved", pageId: "concepts/test2" }]);
  });

  it.each([
    ["concepts", "test2"],
    ["concepts", "rbac-por-oficina"],
    ["concepts", "7-subdominios-ddd"],
    ["queries", "rbac-por-oficina"],
  ])("resolves %s/%s, which exists in the stack", async (directory, stem) => {
    const root = await stackWithPage(directory as "concepts" | "queries", stem);
    const page = await retainedIdentity(root, directory, stem);
    const report = await reportAnswerCitations(root, `Grounded in [[${page.id}]].`);

    expect(report.citations).toMatchObject([{ status: "resolved", pageId: page.id }]);
  });
});

describe("a citation whose stored stem is not already a slug", () => {
  // Page identity keeps the RAW filename stem (answer-index.ts:33), while the body
  // target is slugified before resolution (wikilink-tokens.ts:53). A page authored or
  // migrated with a title-shaped stem is therefore cited by its own title in a form
  // that can never equal its stored identity. No `/` is involved in this case, which
  // is what separates it from the separator loss above.
  it.each([
    ["concepts", "7. Subdominios DDD"],
    ["concepts", "Raw Name"],
  ])("resolves %s/%s cited by its own title", async (directory, stem) => {
    const root = await stackWithPage(directory as "concepts" | "queries", stem);
    const page = await retainedIdentity(root, directory, stem);
    const report = await reportAnswerCitations(root, `Grounded in [[${stem}]].`);

    expect(report.citations).toMatchObject([{ status: "resolved", pageId: page.id }]);
  });
});

/**
 * Render `body` through the viewer's production wikilink rule. `renderPageHtml`
 * (`packages/wiki/src/viewer/render.ts:66`) registers exactly this rule over the
 * snapshot's pages, so the parse/resolve/render chain under test is the rendered
 * one, not a re-implementation of it.
 */
function renderBody(body: string, pages: ViewerPage[]): string {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  registerWikilink(md, { pages });
  return md.render(body);
}

describe("a body wikilink naming an existing page by its qualified identity", () => {
  // The response body carries `[[concepts/test2]]` links while the citation list
  // reports the same page as `conceptstest2` (the production asymmetry). Both go
  // through the shared tokenizer and the shared resolver, so both must survive.
  it("renders [[concepts/test2]] as a live anchor, not a missing link", async () => {
    const root = await stackWithPage("concepts", "test2");
    const page = await retainedIdentity(root, "concepts", "test2");
    const html = renderBody(`Grounded in [[${page.id}]].`, await collectViewerPages(root));

    expect(html).toContain('data-page-id="concepts/test2"');
    expect(html).not.toContain("data-missing");
  });

  it("still renders a genuinely absent page as data-missing", async () => {
    const root = await stackWithPage("concepts", "test2");
    const html = renderBody("Grounded in [[concepts/ghost]].", await collectViewerPages(root));

    expect(html).toContain('data-missing="true"');
  });
});

/**
 * The link graph is the THIRD path over the same targets: `collectViewerPages`
 * records outgoing links and dangling ghosts through the regex extractors in
 * `packages/wiki/src/wiki/collect.ts` (`extractWikilinkSlugs` / `extractWikilinkTargets`),
 * not through the tokenizer. A rendering that resolves while the graph still calls
 * the same link dangling is the same defect in a third place.
 */
describe("the viewer link graph of a body citing a page by its qualified identity", () => {
  it("records the qualified link and keeps only genuinely absent targets dangling", async () => {
    const root = await stackWithPage("concepts", "test2", "See [[concepts/test2]] and [[queries/test2]].");
    const page = (await collectViewerPages(root)).find((candidate) => candidate.slug === "test2");

    // `queries/test2` names no page in this stack, so it stays dangling — while the
    // separator-mangled `conceptstest2` may not appear anywhere. `danglingLinks` is
    // OPTIONAL on `ViewerPage`, so it is read as defined-or-empty here.
    expect(page?.outgoingLinks).toEqual(["concepts/test2"]);
    expect((page?.danglingLinks ?? []).map((link) => link.slug)).toEqual(["queries/test2"]);
  });
});

/** Resolve one citation over a two-page stack and return the page id it reached. */
async function resolveOverAmbiguousStack(stems: string[], citation: string): Promise<string | null> {
  const root = await stackWithPages("concepts", stems.map((stem) => ({ stem })));
  const report = await reportAnswerCitations(root, `Grounded in [[${citation}]].`);
  const [first] = report.citations;
  return first?.status === "resolved" ? first.pageId : null;
}

/**
 * A cited slug that BOTH an exact-stem page and a title-shaped page answer.
 *
 * Creation order is readdir order on the filesystems this suite runs on, so both
 * orders are separate cases: neither assertion may depend on which file the scan
 * met first.
 */
describe("an ambiguous bare citation between an exact stem and a title-shaped stem", () => {
  const orders = [
    { label: "title-shaped page written first", stems: ["7. Subdominios DDD", "7-subdominios-ddd"] },
    { label: "exact-stem page written first", stems: ["7-subdominios-ddd", "7. Subdominios DDD"] },
  ];

  it.each(orders)("prefers the exact stem when the $label", async ({ stems }) => {
    expect(await resolveOverAmbiguousStack(stems, "7-subdominios-ddd")).toBe("concepts/7-subdominios-ddd");
  });

  // The disk cases depend on which file the scan met first, and a filesystem that
  // yields the title-shaped page first would hide the defect. This case fixes the
  // index order explicitly, so the precedence is proven rather than observed.
  it("prefers the exact stem in EITHER index order", () => {
    // Typed through the resolver's own parameter, so the literal entries cannot widen
    // `pageDirectory` to `string` — and no assertion or cast is needed to fit them.
    type Index = Parameters<typeof resolveBareSlug>[1];
    const pages: Index = [
      { id: "concepts/7. Subdominios DDD", pageDirectory: "concepts", slug: "7. Subdominios DDD" },
      { id: "concepts/7-subdominios-ddd", pageDirectory: "concepts", slug: "7-subdominios-ddd" },
    ];

    // Exact-stem page LAST (the order a scan may well not produce) and first.
    expect(resolveBareSlug("7-subdominios-ddd", pages)).toBe("concepts/7-subdominios-ddd");
    expect(resolveBareSlug("7-subdominios-ddd", [...pages].reverse())).toBe("concepts/7-subdominios-ddd");
  });

  it.each(orders)("resolves the title-shaped citation deterministically ($label)", async ({ stems }) => {
    // Both spellings normalize to the SAME target (`7-subdominios-ddd` once slugified),
    // so by the time resolution runs the title-shaped citation is indistinguishable
    // from the bare slug and takes the same exact-stem winner. Determinism is what is
    // guaranteed here; preferring the title-shaped page would need the RAW target,
    // which the tokenizer does not carry into resolution.
    expect(await resolveOverAmbiguousStack(stems, "7. Subdominios DDD")).toBe("concepts/7-subdominios-ddd");
  });
});

/**
 * The S7 property over a stack of arbitrary pages: every citation form of an
 * existing page — its qualified id, its bare stem, and the title the helper writes
 * into frontmatter (the same text as the stem) — resolves to that page's identity.
 * Pages are the case, expectations are derived: no per-page hardcoding.
 */
describe("every citation form of an existing page resolves to that page", () => {
  it.each([
    ["concepts", "test2"],
    ["concepts", "rbac-por-oficina"],
    ["concepts", "7-subdominios-ddd"],
    ["concepts", "7. Subdominios DDD"],
    ["queries", "test2"],
  ])("%s/%s resolves as qualified id, bare stem and frontmatter title", async (directory, stem) => {
    const root = await stackWithPage(directory as "concepts" | "queries", stem);
    const page = await retainedIdentity(root, directory, stem);
    const viewerPage = (await collectViewerPages(root))
      .find((candidate) => candidate.pageDirectory === directory && candidate.slug === stem);
    // The helper writes `title: "<stem>"`, so the frontmatter-title form is proven for
    // the case where the title and the filename stem are the same text. A title that
    // differs from the stem has no resolver here unless the page declares it as an
    // alias (see `hasAliasSlug` in the viewer resolver).
    for (const cited of [page.id, stem, viewerPage?.title]) {
      const report = await reportAnswerCitations(root, `Grounded in [[${cited}]].`);
      expect(report.citations).toMatchObject([{ status: "resolved", pageId: page.id }]);
    }
  });
});

/**
 * The namespace decision, pinned as intent: an explicit namespace is never
 * second-guessed, so no future cross-namespace fallback can be added silently.
 */
describe("a qualified citation is confined to its own namespace", () => {
  it("keeps [[queries/test2]] broken when only concepts/test2 exists", async () => {
    const root = await stackWithPage("concepts", "test2");
    const report = await reportAnswerCitations(root, "Grounded in [[queries/test2]].");

    expect(report.citations).toMatchObject([{ target: "queries/test2", status: "broken" }]);
  });
});

describe("a citation naming an existing page by its bare slug", () => {
  // PRESERVE: this is the resolution behavior the viewer and the report share today,
  // and a citation the model writes as a bare slug still reaches it.
  it.each(["test2", "rbac-por-oficina", "7-subdominios-ddd"])("keeps %s resolved", async (stem) => {
    const root = await stackWithPage("concepts", stem);
    const page = await retainedIdentity(root, "concepts", stem);
    const report = await reportAnswerCitations(root, `Grounded in [[${stem}]].`);

    expect(report.citations).toMatchObject([{ status: "resolved", pageId: page.id }]);
  });
});
