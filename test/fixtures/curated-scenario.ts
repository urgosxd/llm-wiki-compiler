/**
 * @file The two-page curated-link scenario shared by the stability and overlay tests.
 *
 * WHY A FIXTURE. Every case about curated links needs the same four moves: a source
 * whose page MENTIONS the target by an alias, a second source whose page IS the target,
 * a compile that curates the link, and a re-ingest of either page. Writing those moves
 * per file is how two tests start measuring slightly different scenarios -- and the
 * whole asymmetry under test here (title mentions are re-wrapped by the resolver, alias
 * mentions are not) makes that difference invisible: a case built on a title mention
 * would pass on the broken code.
 *
 * EVERY CURATION CONSTANT HERE ANCHORS ON AN ALIAS for that reason. `DECLARED_ALIAS`
 * differs from the title's canonical key by hand, and `MERGED_ALIAS` is the spelling the
 * identity stage folds, so neither can be re-created by the resolver's title pass.
 *
 * The store reader is part of the fixture because three cases assert what the durable
 * record holds, and the file is the record's public artifact (it is documented in
 * `constants.ts` as `.llmwiki/curated-links.json`).
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { buildFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { CURATED_LINKS_FILE } from "../../packages/wiki/src/utils/constants.js";
import { declareAlias } from "./concept-page.js";
import { stubCompileProvider } from "./compile-provider.js";

/** Source whose page MENTIONS the link target by an alias. */
export const ALPHA_SOURCE = "alpha.md";

/** Source whose ingest creates the LINK TARGET, titled `Vector DB`. */
export const BETA_SOURCE = "beta.md";

/** Marker that routes the extraction stub to the beta source. */
export const BETA_MARKER = "BETA SOURCE TEXT";

/** An alias whose canonical key differs from the title's, declared in frontmatter. */
export const DECLARED_ALIAS = "pgvector store";

/** The alias the identity stage folds from beta's two spellings. */
export const MERGED_ALIAS = "Vector Database";

/** Alpha's body: names the target by its DECLARED alias, never by its title. */
export const ALPHA_BODY = "Alpha Topic stores vectors in a pgvector store. ^[alpha.md]";

/** Alpha's body: names the target by the alias the identity fold produced. */
export const ALPHA_BODY_MERGED_NAME = "Alpha Topic stores vectors in a Vector Database. ^[alpha.md]";

/** Alpha's body once the mention that justified the curated link is gone. */
export const ALPHA_BODY_WITHOUT_TARGET = "Alpha Topic stores vectors only. ^[alpha.md]";

/** Alpha's body mentioning the target by its TITLE, which the resolver re-wraps itself. */
export const ALPHA_BODY_TITLE_MENTION = "Alpha Topic compares with Vector DB. ^[alpha.md]";

/** Beta's body: the target article itself. */
export const BETA_BODY = "Vector DB keeps embeddings for retrieval. ^[beta.md]";

/** The review stub's answer for one call, as the verdict tool returns it. */
export type Verdict = (system: string) => string;

/** A verdict that links the mention of the DECLARED alias. */
export const linkDeclaredAlias: Verdict = () =>
  JSON.stringify({ should_link: true, mention: DECLARED_ALIAS });

/** A verdict that links the mention of the MERGED alias. */
export const linkMergedAlias: Verdict = () =>
  JSON.stringify({ should_link: true, mention: MERGED_ALIAS });

/**
 * A verdict that links whichever of the two aliases the passage actually mentions.
 *
 * Needed because a verdict is one answer PER CANDIDATE and an answer the page cannot
 * anchor is counted unusable, so a fixed answer would mark the second candidate unusable
 * and measure nothing.
 */
export const linkWhicheverAliasIsMentioned: Verdict = (system) =>
  JSON.stringify({
    should_link: true,
    mention: system.includes(MERGED_ALIAS) ? MERGED_ALIAS : DECLARED_ALIAS,
  });

/** Extraction payload naming one concept. */
export function extractionFor(title: string): string {
  return JSON.stringify({
    concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }],
  });
}

/**
 * Beta's extraction: ONE concept under two spellings the canonical key folds.
 *
 * This is how a page legitimately acquires an alias: `Vector Database` folds into
 * `Vector DB`, so the page is titled `Vector DB` and declares the other name.
 */
export function betaExtraction(): string {
  return JSON.stringify({
    concepts: [
      { concept: "Vector DB", summary: "Vector storage.", is_new: true, confidence: 0.9 },
      { concept: MERGED_ALIAS, summary: "Vector storage.", is_new: false, confidence: 0.5 },
    ],
  });
}

/**
 * Stub the compile's provider calls.
 *
 * Extraction routes on the source TEXT, because the extraction prompt also carries the
 * existing wiki index and therefore every title compiled so far.
 *
 * @param alphaBody - Alpha's rendered body for each successive render.
 * @param verdict - What the reference review answers; omitted means the review cannot
 *   read an answer at all, which is how a case keeps the curated channel out of the way.
 */
export function stubProvider(alphaBody: () => string, verdict?: Verdict): void {
  stubCompileProvider({
    extraction: (system) =>
      system.includes(BETA_MARKER) ? betaExtraction() : extractionFor("Alpha Topic"),
    body: (system) => (system.includes('Concept to write about: "Vector DB"') ? BETA_BODY : alphaBody()),
    review: verdict,
  });
}

/** Write one source file, replacing whatever was there. */
export async function writeSource(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", file), content, "utf-8");
}

/** Write an already-compiled page of the wiki that no source of this run produced. */
export async function writeEarlierPage(
  root: string,
  slug: string,
  title: string,
  body: string,
): Promise<void> {
  const fields = { title, summary: `Summary of ${title}.`, kind: "concept", sources: [] };
  await writeFile(
    path.join(root, "wiki/concepts", `${slug}.md`),
    `${buildFrontmatter(fields)}\n\n${body}\n`,
    "utf-8",
  );
}

/**
 * Ingest alpha, then beta -- creating the article and its folded alias -- then declare
 * the second alias the curation cases anchor on.
 *
 * @param root - Project root.
 * @param alphaBody - Alpha's body for each successive render.
 * @param verdict - The review model's answer; the default accepts the alias mention.
 */
export async function ingestBoth(
  root: string,
  alphaBody: () => string = () => ALPHA_BODY,
  verdict: Verdict = linkDeclaredAlias,
): Promise<void> {
  stubProvider(alphaBody, verdict);
  await writeSource(root, ALPHA_SOURCE, `# Alpha Topic\n\n${ALPHA_BODY}\n`);
  await compileAndReport(root);
  await writeSource(root, BETA_SOURCE, `# Vector DB\n\n${BETA_MARKER}. Vector DB keeps embeddings.\n`);
  await compileAndReport(root);
  await declareAlias(root, "vector-db", DECLARED_ALIAS);
}

/** Re-ingest alpha alone, with a source revision that changes nothing else. */
export async function reingestAlpha(root: string): Promise<void> {
  await writeSource(root, ALPHA_SOURCE, `# Alpha Topic\n\n${ALPHA_BODY} Revised.\n`);
  await compileAndReport(root);
}

/** Re-ingest beta alone, so the run's ONLY article is the link target. */
export async function reingestBeta(root: string): Promise<void> {
  await writeSource(
    root,
    BETA_SOURCE,
    `# Vector DB\n\n${BETA_MARKER}, revised. Vector DB keeps embeddings.\n`,
  );
  await compileAndReport(root);
}

/**
 * Make a COMPILE curate the link, which is the only way to exercise the durable record
 * through the pipeline.
 *
 * WHY IT TAKES A SECOND INGEST. The declared alias reaches the target page only in the
 * frontmatter the ingest that created it wrote, so the run that can review a mention of
 * it is a LATER one: this re-ingests the target, whose reference review then finds the
 * earlier page naming the alias and curates the link. That is the real shape of the
 * feature -- a reviewer sees a wiki that already exists -- and it keeps the curation on
 * the compile path instead of calling the stage by hand.
 *
 * @param root - Project root prepared by {@link ingestBoth}.
 * @param verdict - The review model's answer; defaults to accepting the alias mention.
 * @param alphaBody - Alpha's rendered body, for a case whose later render differs.
 */
export async function curateLinkToBeta(
  root: string,
  verdict: Verdict = linkDeclaredAlias,
  alphaBody: () => string = () => ALPHA_BODY,
): Promise<void> {
  stubProvider(alphaBody, verdict);
  await reingestBeta(root);
}

/** One stored curated link, as `.llmwiki/curated-links.json` holds it. */
export interface StoredCuratedLink {
  stableKey: string;
  sourcePageId: string;
  targetPageId: string;
  anchor: { text: string; before: string; after: string };
  provenance: string;
  createdAt: string;
}

/** The absolute path of the curated-link store of one project. */
export function curatedStorePath(root: string): string {
  return path.join(root, CURATED_LINKS_FILE);
}

/**
 * The project's curated-link store, or null when the file does not exist.
 *
 * A file read rather than a call into the store module: the store is the artifact under
 * test, and a case that asked the same module to read what it wrote could not tell a
 * missing record from a mis-read one.
 *
 * @param root - Project root.
 * @returns The parsed store, or null when nothing was ever recorded.
 */
export async function readCuratedStore(
  root: string,
): Promise<{ version: number; links: StoredCuratedLink[] } | null> {
  const raw = await readFile(curatedStorePath(root), "utf-8").catch(() => null);
  return raw === null ? null : JSON.parse(raw);
}

/** The curated records of one source page, in stored order. */
export async function curatedRecordsFor(
  root: string,
  sourcePageId: string,
): Promise<StoredCuratedLink[]> {
  const store = await readCuratedStore(root);
  return (store?.links ?? []).filter((link) => link.sourcePageId === sourcePageId);
}
