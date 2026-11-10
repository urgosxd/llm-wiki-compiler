/**
 * Wiki page rendering for the compile pipeline.
 *
 * Encapsulates the single-page generation step: gather related pages, call
 * the LLM, build frontmatter, and produce the final markdown blob. Splitting
 * this away from the orchestrator (`compiler/index.ts`) keeps the orchestrator
 * focused on phase sequencing and lets the review-candidate code path reuse
 * the exact same renderer used for direct writes.
 *
 * WHERE LINK VALIDATION HAPPENS. Not here. A generated body is one of the two
 * channels that put links on a page, and the other channel (`resolveLinks`) runs
 * later, in the link phase. Gating here would judge half of the body's links and
 * would judge a link into a page this run is still creating as missing. The ONE
 * gate therefore runs on the final body in the link phase; this module returns the
 * body as written and leaves every link to it.
 */

import { readdir } from "fs/promises";
import path from "path";
import {
  buildFrontmatter,
  extractClaimCitations,
  parseFrontmatter,
  slugify,
} from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import { callClaude } from "../utils/llm.js";
import { buildPagePrompt } from "./prompts.js";
import { addObsidianMeta } from "./obsidian.js";
import { addModelProvenanceMeta, addProvenanceMeta, reportContradictionWarnings } from "./provenance.js";
import { normalizeCitationsInBody } from "./citation-normalize.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import type { SchemaConfig } from "../schema/index.js";
import type { ExtractedConcept } from "../utils/types.js";

/** Maximum number of existing concept pages to include as cross-reference context. */
const RELATED_PAGE_CONTEXT_LIMIT = 5;

/** A sibling page a generation prompt may be shown, with the bytes that rank it. */
export interface RelatedPageCandidate {
  /** The page's slug, used as the deterministic tie-break. */
  slug: string;
  /** Full markdown, frontmatter included: the text a mention is looked for in. */
  content: string;
}

/**
 * The sibling pages of one wiki, read ONCE for a whole compile run.
 *
 * WHY AN INDEX AND NOT A LIVE LISTING. Ranking pages by relevance needs every
 * sibling's text, so a renderer that listed and read the directory per page would
 * turn one compile into O(pages x pages) confined reads. The pipeline builds this
 * index once and hands the same object to every page, which also means two pages of
 * the same run cannot rank against different snapshots of the wiki.
 */
export interface RelatedPageIndex {
  /** Every readable, non-orphaned concept page of the wiki. */
  readonly candidates: readonly RelatedPageCandidate[];
}

/** A merged-concept input from the orchestrator (multiple sources merged into one). */
interface RenderableConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
  rebuild?: boolean;
  /**
   * Names that folded INTO this page, as decided by the identity stage.
   *
   * Passed in rather than recomputed here: the fold is an identity decision, and a
   * renderer that re-derived it would be a second source of truth for what a page is.
   */
  aliases?: readonly string[];
  /**
   * The run's shared sibling-page index, when the caller built one.
   *
   * Optional so a single-page caller (a test, the review path) still works: without
   * it the renderer reads the siblings itself, which is correct and merely pays the
   * read per page.
   */
  relatedPages?: RelatedPageIndex;
  /**
   * The run's shared attribution accumulator, when the caller built one.
   *
   * Carried on the entry for the same reason {@link relatedPages} is: it is ONE object
   * per compile run, handed to every page, so the renderer records a page's gap without
   * the pipeline threading a second argument through the candidate/live branches. Absent
   * for a single-page caller (a test), where the page is still marked but nothing
   * aggregates it.
   */
  attribution?: AttributionSink;
}

/**
 * Render a wiki page (frontmatter + body) for a merged concept by calling
 * the LLM with cross-referencing context from existing concept pages.
 * @param root - Project root directory.
 * @param entry - The merged concept to render.
 * @param schema - Resolved schema config, used to stamp `kind` on frontmatter.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns Full markdown content (frontmatter + body, trailing newline).
 */
export async function renderMergedPageContent(
  root: string,
  entry: RenderableConcept,
  schema: SchemaConfig,
  source?: PageContentSource,
): Promise<string> {
  const existingPage = await readWikiPageFrom(
    root, CONCEPTS_DIR, entry.slug, source, false /* new page — absence is normal */,
  );
  const relatedPages = await loadRelatedPages(root, entry, source);

  const system = buildPagePrompt(
    entry.concept.concept,
    entry.combinedContent,
    entry.rebuild ? "" : existingPage,
    relatedPages,
  );

  const rawPageBody = await callClaude({
    system,
    messages: [
      { role: "user", content: `Write the wiki page for "${entry.concept.concept}".` },
    ],
  });

  const pageBody = normalizeCitationsInBody(
    rawPageBody,
    entry.sourceFiles,
    entry.combinedContent,
    entry.rebuild === true,
  );
  // ONE census, three surfaces: the gap is recorded on the run's accumulator, printed, and
  // written into the page's own frontmatter -- all from this single reading of the body.
  const census = censusSourceAttribution(pageBody, entry.sourceFiles);
  const gap = markAttributionGap(entry, census);
  reportAttributionGap(entry.concept.concept, census);

  const frontmatter = buildMergedFrontmatter(entry, existingPage, schema, gap);
  reportContradictionWarnings(entry.concept.concept, entry.concept);
  return `${frontmatter}\n\n${pageBody}\n`;
}

/*
 * THE ATTRIBUTION MARKER, AND WHY IT IS OBSERVABLE RATHER THAN ONLY PRINTED.
 *
 * The Manager's rule: a page that is not fully attributed is never PRESENTED as fully
 * attributed. A merged article whose prose attributes one of its two sources used to be
 * written with `sources: [alpha.md, beta.md]` and nothing else, so the stored page looked
 * exactly like a fully attributed one to a reader, an exporter or a host replaying the
 * corpus later -- the run's warning was the only trace, and it does not travel with the
 * page. Three surfaces, ONE detection (the census below), and the page is still WRITTEN:
 * holding it back would delete content nobody asked to lose, which is not the rule.
 */

/** One page whose prose leaves at least one contributing source unattributed. */
export interface AttributionGap {
  /** The page's title, as its frontmatter records it: what a reader of the run sees. */
  page: string;
  /** Contributing sources no citation marker in the body names, in source-list order. */
  missing: readonly string[];
}

/**
 * The accumulator ONE compile run fills while it renders its pages.
 *
 * A shared mutable sink rather than a return value because the renderer's result IS the
 * page: every caller of {@link renderMergedPageContent} writes it, and a page that
 * reported its gap by changing its return shape would change the contract for the review
 * candidate path too. Gaps are appended as pages settle, so the totals below sort them:
 * the printed line must be a function of the SET of imperfect pages, never of the order a
 * concurrent run happened to finish them in.
 */
export interface AttributionSink {
  /** Every gap recorded so far, in completion order. */
  readonly gaps: AttributionGap[];
}

/**
 * Start the accumulator a compile run hands to every page it renders.
 * @returns An empty sink.
 */
export function createAttributionSink(): AttributionSink {
  return { gaps: [] };
}

/** What a whole run's attribution marking adds up to. */
export interface AttributionCounts {
  /** How many pages of the run are not fully attributed. */
  pages: number;
  /** How many source references are missing across those pages. */
  missing: number;
  /** The gaps themselves, in page-title order (UTF-16 code unit, never the locale). */
  gaps: readonly AttributionGap[];
}

/**
 * Turn a run's accumulator into its totals, sorted by page title.
 *
 * The sort is what makes the aggregate line deterministic: pages are rendered in
 * parallel, so appending order is a property of the machine, not of the wiki.
 * @param sink - The accumulator the run's renderer filled.
 * @returns The run's totals.
 */
export function attributionCountsOf(sink: AttributionSink): AttributionCounts {
  const gaps = [...sink.gaps].sort((left, right) => (left.page < right.page ? -1 : left.page > right.page ? 1 : 0));
  return {
    pages: gaps.length,
    missing: gaps.reduce((sum, gap) => sum + gap.missing.length, 0),
    gaps,
  };
}

/**
 * The ONE counted line a compile prints for this rule, in the shape of its other
 * refusal lines: it aggregates across pages and names each page with what it leaves out.
 * @param counts - The run's totals.
 * @returns The line, or null when every page attributed every contributing source.
 */
export function describeAttribution(counts: AttributionCounts): string | null {
  if (counts.pages === 0) return null;
  const detail = counts.gaps
    .map((gap) => `${gap.page} is missing ${gap.missing.join(", ")}`)
    .join("; ");
  return `Attribution: ${counts.pages} page(s) not fully attributed ` +
    `(${counts.missing} source reference(s) missing) — ${detail}`;
}

/**
 * The compile SUMMARY mention: the same count, stated beside the run's headline.
 *
 * It carries no page names on purpose -- the counted line above it does -- because its job
 * is that a reader who stops at the completion banner cannot conclude the run's pages are
 * complete.
 * @param counts - The run's totals.
 * @returns The summary line, or null when every page attributed every source.
 */
export function describeAttributionSummary(counts: AttributionCounts): string | null {
  if (counts.pages === 0) return null;
  return `Attribution summary: ${counts.pages} page(s) of this run not fully attributed ` +
    `(${counts.missing} source reference(s) missing).`;
}

/** Which of a page's contributing sources its prose actually attributes, and which not. */
interface AttributionCensus {
  /** Contributing sources at least one citation marker names, in source-list order. */
  attributed: string[];
  /** Contributing sources no citation marker names. */
  unattributed: string[];
}

/**
 * Count which of a page's contributing sources its body attributes (S2, S7).
 *
 * WHY THIS EXISTS. `mergeExtractions` collects every contributing source and the
 * frontmatter lists them, which proves the page KNOWS its sources -- never that its prose
 * attributes a claim to each of them. A merged article that cites one source and silently
 * absorbs the other is the "concatenation without attribution" S2 rejects, and nothing
 * before this read the rendered body to notice.
 *
 * The reading uses the repository's own citation convention, `extractClaimCitations`, so
 * "attributed" means exactly what the viewer, the citation lint and the source-utilization
 * report already mean by it: a `^[file.md:lines]` entry naming that source file. No
 * heuristic, no fuzzy title match, no score.
 *
 * @param body - The rendered page body, frontmatter excluded.
 * @param sourceFiles - Every source that contributed to this page.
 * @returns The sources the body attributes and the sources it does not.
 */
function censusSourceAttribution(
  body: string,
  sourceFiles: readonly string[],
): AttributionCensus {
  const cited = new Set<string>();
  for (const citation of extractClaimCitations(body)) {
    for (const span of citation.spans) {
      if (span.file.length > 0) cited.add(span.file);
    }
  }
  return {
    attributed: sourceFiles.filter((file) => cited.has(file)),
    unattributed: sourceFiles.filter((file) => !cited.has(file)),
  };
}

/**
 * Decide whether a census is a gap worth MARKING, and record it on the run's accumulator.
 *
 * The same predicate {@link reportAttributionGap} prints on, so the page's marker and the
 * run's line can never disagree about which pages are imperfect. Silence below two
 * contributing sources is deliberate and shared: single-source citation hygiene is the
 * citation lint's job, and the rule this marks is the MERGED page (S2).
 * @param entry - The page being rendered, carrying the run's accumulator when it has one.
 * @param census - What the rendered body attributed.
 * @returns The gap to stamp into frontmatter, or null for a fully attributed page.
 */
function markAttributionGap(
  entry: RenderableConcept,
  census: AttributionCensus,
): AttributionGap | null {
  if (!isAttributionGap(census)) return null;
  const gap: AttributionGap = { page: entry.concept.concept, missing: [...census.unattributed] };
  entry.attribution?.gaps.push(gap);
  return gap;
}

/**
 * Whether a page's prose attributes every contributing source: the ONE rule all three
 * surfaces read, so no two of them can classify a page differently.
 * @param census - What the rendered body attributed.
 * @returns True when the page draws on more than one source and names fewer than all.
 */
function isAttributionGap(census: AttributionCensus): boolean {
  const total = census.attributed.length + census.unattributed.length;
  return census.unattributed.length > 0 && total >= 2;
}

/**
 * Report a MERGED article that leaves one of its contributing sources unattributed.
 *
 * WHAT THIS IS, AND IS NOT. It is the observable half of the prompt rule: the prompt asks
 * the model to attribute every contributing source, and this states, per page, whether it
 * did -- naming each source nobody can trace a claim to. It is not a gate: rewriting or
 * holding back a page over a missing marker would destroy content nobody asked to lose,
 * and provenance hygiene for a SINGLE-source page is already the citation lint's job, so
 * this stays silent below two contributing sources and reports the merge case S2 is about.
 *
 * It prints on the compile's own output beside the link and category lines, for the same
 * reason they do: a source whose contribution vanished into an unattributed paragraph is
 * exactly the silent partial result S12 forbids.
 *
 * @param concept - The page's title, as the frontmatter records it.
 * @param census - What the rendered body attributed.
 */
function reportAttributionGap(concept: string, census: AttributionCensus): void {
  if (!isAttributionGap(census)) return;
  const total = census.attributed.length + census.unattributed.length;
  output.status("!", output.warn(
    `Page "${concept}" merges ${total} source(s) but attributes ${census.attributed.length}: ` +
    `no statement is attributed to ${census.unattributed.join(", ")}.`,
  ));
}

/**
 * Construct the frontmatter block for a merged concept, preserving createdAt
 * and stamping the `kind` field from the schema's default kind.
 *
 * `attributionGaps` is written ONLY when the page is not fully attributed, so a complete
 * page keeps exactly the frontmatter it had before this field existed (no empty array
 * polluting pages) and a page compiled earlier stays valid without it.
 *
 * @param entry - The concept being rendered.
 * @param existingPage - The page already on disk, read for its own fields.
 * @param schema - Resolved schema config, source of the default `kind`.
 * @param gap - The attribution gap the renderer just measured, or null when there is none.
 * @returns The frontmatter block, fences included.
 */
function buildMergedFrontmatter(
  entry: RenderableConcept,
  existingPage: string,
  schema: SchemaConfig,
  gap: AttributionGap | null = null,
): string {
  const now = new Date().toISOString();
  const existing = existingPage ? parseFrontmatter(existingPage) : null;
  const createdAt = (existing?.meta.createdAt && typeof existing.meta.createdAt === "string")
    ? existing.meta.createdAt
    : now;
  const frontmatterFields: Record<string, unknown> = {
    title: entry.concept.concept,
    summary: entry.concept.summary,
    sources: entry.sourceFiles,
    kind: schema.defaultKind,
    createdAt,
    updatedAt: now,
  };
  addObsidianMeta(frontmatterFields, entry.concept.concept, entry.concept.tags ?? []);
  addProvenanceMeta(frontmatterFields, entry.concept);
  addModelProvenanceMeta(frontmatterFields);
  applyDeclaredAliases(frontmatterFields, entry, existing?.meta.aliases);
  if (gap !== null) frontmatterFields.attributionGaps = [...gap.missing];
  return buildFrontmatter(frontmatterFields);
}

/**
 * Merge the page's own aliases, the ones it already declared, and every name that
 * folded into it into one deduplicated list.
 *
 * Three rules, all observable in the written page: an alias the page already
 * declared survives (dropping it would forget a resolved synonym and split the
 * concept again next ingest); duplicates collapse on their slug, so the same name
 * spelled twice is listed once; and the canonical title is never listed as its own
 * alias, because a self-alias would make every page its own synonym.
 *
 * @param fields - Frontmatter fields to mutate, after the generated aliases exist.
 * @param entry - The concept being rendered, carrying the folded names.
 * @param declared - Aliases the existing page already declared, if it had any.
 */
function applyDeclaredAliases(
  fields: Record<string, unknown>,
  entry: RenderableConcept,
  declared: unknown,
): void {
  const title = entry.concept.concept.trim();
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...stringList(fields.aliases), ...stringList(declared), ...(entry.aliases ?? [])]) {
    const alias = raw.trim();
    const key = slugify(alias);
    if (alias === "" || alias.toLowerCase() === title.toLowerCase() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(alias);
  }
  if (merged.length === 0) {
    delete fields.aliases;
    return;
  }
  fields.aliases = merged;
}

/** Reduce a frontmatter value to the plain strings it may contain. */
function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is string => typeof value === "string");
}

/**
 * Read this wiki's sibling pages into the one index a run shares.
 *
 * Orphaned pages are dropped here rather than at read time: the wiki no longer
 * serves them, so offering one as cross-reference context would point the model at
 * a page the reader cannot reach. Each read stays confined to `wiki/concepts`: a
 * symlinked entry whose target escapes that dir is dropped (warned, skipped) so its
 * bytes never enter the generation prompt.
 *
 * @param root - Project root directory.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The sibling pages, in slug order.
 */
export async function buildRelatedPageIndex(
  root: string,
  source?: PageContentSource,
): Promise<RelatedPageIndex> {
  const slugs = source === undefined
    ? (await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -".md".length))
      .sort()
    : [...await source.listSlugs("concepts")].sort();
  const candidates: RelatedPageCandidate[] = [];
  for (const slug of slugs) {
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, slug, source);
    if (content === "") continue;
    if (parseFrontmatter(content).meta.orphaned) continue;
    candidates.push({ slug, content });
  }
  return { candidates };
}

/**
 * Rank the sibling pages a generation prompt may be shown, most relevant first.
 *
 * THE DEFECT THIS REPLACES. The context used to be the first N slugs of the
 * directory, so the ``related'' pages a model saw were whichever ones sorted first
 * alphabetically -- retrieval without relevance, which is the same class of mistake
 * as linking on a similarity score. The ranking here is deterministic and textual:
 * pages that MENTION the concept's canonical name come first (most mentions first),
 * then pages that mention one of its aliases, and the remaining ties break on slug
 * so the same wiki always produces the same context.
 *
 * It ranks RETRIEVAL ONLY. Nothing here creates, proposes or scores a link: the
 * ranked list becomes prompt context, and every link a page ends up with is
 * decided later by the link gate. No embedding and no vector store is consulted,
 * so no score can decide anything (S14).
 *
 * @param candidates - The wiki's sibling pages.
 * @param names - The concept's canonical name followed by its aliases.
 * @param excludeSlug - Slug of the page being generated.
 * @param limit - How many pages the prompt may see.
 * @returns Slugs, most relevant first, capped at `limit`.
 */
export function rankRelatedSlugs(
  candidates: readonly RelatedPageCandidate[],
  names: readonly string[],
  excludeSlug: string,
  limit: number,
): string[] {
  const [title, ...aliases] = names.filter((name) => name.trim() !== "");
  if (title === undefined) return [];
  return candidates
    .filter((candidate) => candidate.slug !== excludeSlug)
    .map((candidate) => ({
      slug: candidate.slug,
      titleHits: countMentions(candidate.content, title),
      aliasHits: aliases.reduce((sum, alias) => sum + countMentions(candidate.content, alias), 0),
    }))
    .sort((left, right) => compareRanked(left, right))
    .slice(0, limit)
    .map((scored) => scored.slug);
}

/** One page's relevance counters, as {@link rankRelatedSlugs} compares them. */
interface RankedSlug {
  slug: string;
  titleHits: number;
  aliasHits: number;
}

/** Most title mentions, then most alias mentions, then slug: a total order. */
function compareRanked(left: RankedSlug, right: RankedSlug): number {
  if (left.titleHits !== right.titleHits) return right.titleHits - left.titleHits;
  if (left.aliasHits !== right.aliasHits) return right.aliasHits - left.aliasHits;
  return left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0;
}

/**
 * How many times `needle` occurs in `haystack`, case-insensitively.
 *
 * A plain substring count on purpose: this ranks context, so near-misses are a
 * ranking signal rather than a link, and reporting an exact count keeps the order
 * reproducible without a tokenizer or a locale-sensitive collator.
 *
 * @param haystack - The page markdown.
 * @param needle - The name to count.
 * @returns The number of occurrences (0 for an empty needle).
 */
function countMentions(haystack: string, needle: string): number {
  if (needle.trim() === "") return 0;
  const hay = haystack.toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let offset = hay.indexOf(target);
  while (offset !== -1) {
    count += 1;
    offset = hay.indexOf(target, offset + target.length);
  }
  return count;
}

/**
 * Load the cross-referencing context for one page, most relevant pages first.
 * @param root - Project root directory.
 * @param entry - The concept being rendered, carrying its own names.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns Concatenated related page contents (empty when no related page exists).
 */
async function loadRelatedPages(
  root: string,
  entry: RenderableConcept,
  source?: PageContentSource,
): Promise<string> {
  const index = entry.relatedPages ?? await buildRelatedPageIndex(root, source);
  const names = [entry.concept.concept, ...(entry.aliases ?? [])];
  const slugs = rankRelatedSlugs(index.candidates, names, entry.slug, RELATED_PAGE_CONTEXT_LIMIT);
  const bySlug = new Map(index.candidates.map((candidate) => [candidate.slug, candidate.content]));
  return slugs
    .map((slug) => bySlug.get(slug) ?? "")
    .filter((content) => content !== "")
    .join("\n\n---\n\n");
}
