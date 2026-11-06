/**
 * @file Incremental reference review of EARLIER pages when an article is written.
 *
 * THE REQUIREMENT (S9). "5 Revisar conceptos Al crear o actualizar un artículo,
 * recupera páginas anteriores que podrían necesitar una referencia hacia él.
 * Modifica esas páginas únicamente cuando el enlace tenga sentido en su contenido.
 * No reescribas toda la wiki durante cada ingestión." And S14: "similarity may
 * RETRIEVE candidates, it may never DECIDE ... link creation."
 *
 * RETRIEVAL versus DECISION, stated separately because they are different
 * mechanisms and only one of them may guess:
 *
 *   - RETRIEVAL is deterministic and lexical. An earlier page is a candidate for an
 *     article exactly when its own text already contains one of that article's NAMES
 *     as a PLAIN mention (not inside an existing link, a citation, or a code span).
 *     Its names are the union of three sources, because a synonym resolved by an
 *     EARLIER ingest is still a real name of the concept today: the canonical title,
 *     the aliases the identity stage folded during THIS run, and the `aliases` the
 *     article page persists in its frontmatter. See {@link withDeclaredAliases}.
 *     That is a hard precondition, not a hint: a link
 *     needs words on the page to anchor it, so a page that never names the article
 *     cannot receive one, however similar the two topics are. No embedding, no
 *     cosine score and no vector store is consulted here at all, which is the
 *     strongest form of S14 available: nothing numeric can propose a link.
 *   - DECISION is the model's, and it is per candidate. It sees the page's own
 *     passage and the target article's title and summary, and answers one question:
 *     does linking THIS mention help THIS page's reader? A refusal changes nothing.
 *   - THE ANCHOR is the words the model quoted, and they must still be a real plain
 *     mention of the page at edit time; a verdict the page cannot anchor is counted
 *     as unusable instead of being forced onto the page.
 *
 * WHAT A MODIFIED PAGE LOOKS LIKE. Exactly one span changes: `mention` becomes
 * `[[slug|mention]]`. No re-render, no regeneration, no whitespace churn, and the
 * frontmatter and every other byte stay identical -- the write is built as
 * `content.replace(body, () => newBody)`, the same substitution-safe shape the
 * resolver uses, so no page prose is reinterpreted as a replacement pattern.
 *
 * WHICH PAGES ARE WRITTEN. Only the ones whose text actually changed, through the
 * same trust-floored compile write path the rest of the pipeline uses. A page with
 * no accepted verdict, a refused verdict, or a link the final gate then demotes
 * produces ZERO writes.
 *
 * THE FINAL GATE STILL DECIDES. A link this stage adds is judged again by
 * {@link validateContextualLinks}, against the same rules and per-page budget as
 * every other link, so this stage cannot smuggle in an unanchored, self-referential,
 * redundant or over-budget link. If the gate refuses the new link the body comes
 * back unchanged and nothing is written.
 *
 * BOUNDS, all three named in `constants.ts` beside their reasons and all three
 * COUNTED per reason, never silent (S12): `MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE`,
 * `MAX_LINK_REVIEW_PAGES_PER_RUN` (candidates across the run, i.e. review calls) and
 * `MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN` (actual writes). Truncations are counted
 * under `article-cap`, `run-cap` and `modify-cap` and surface in one compile report
 * line via {@link describeLinkReview}.
 *
 * SCOPE. Concept-namespace pages only: an article is a concept page, and the pages
 * that would reference it are the wiki's articles. Orphaned pages are skipped
 * because they are no longer served by the wiki.
 */

import { readdir } from "fs/promises";
import path from "path";
import { parseFrontmatter } from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { buildLinkReviewPrompt, LINK_REVIEW_TOOL, parseLinkVerdict } from "./prompts.js";
import { isLiteralMarkdown } from "./link-repair-code.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import { linkIndexFor, listLinkPageSet, validateContextualLinks } from "./link-anchoring.js";
import { canonicalConceptKey } from "../dimensions/wiki/concept-identity.js";
import { applyCompilePageWritesLocked, type CompilePageWrite } from "./compile-write.js";
import {
  pageStoreOptions,
  type PageBatchTransaction,
  type PageRemover,
  type PageSink,
} from "../trust/page-apply.js";
import {
  CONCEPTS_DIR,
  MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE,
  MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN,
  MAX_LINK_REVIEW_PAGES_PER_RUN,
} from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";

/** Every `[[target|visible text]]` and `[[target]]` in a body. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** A citation marker `^[...]`: its contents are provenance, not prose to link. */
const CITATION_PATTERN = /\^\[[^\]]*\]/g;

/** One article this run created or updated. */
export interface LinkReviewArticle {
  /** Slug of the article page that was written. */
  slug: string;
  /** Canonical title it was written under. */
  title: string;
  /** Other names the page declares, which a page may mention instead of the title. */
  aliases: readonly string[];
}

/** Why a candidate was dropped by a bound. Each reason is counted separately. */
export type LinkReviewTruncationReason = "article-cap" | "run-cap" | "modify-cap";

/** The truncation reasons, in reporting order. */
const TRUNCATION_REASONS: readonly LinkReviewTruncationReason[] = [
  "article-cap",
  "run-cap",
  "modify-cap",
];

/** What one run's reference review did, in the numbers the compile reports. */
export interface LinkReviewCounts {
  /** Articles created or updated this run that were offered for review. */
  articles: number;
  /** Distinct earlier pages that really mentioned one of those articles. */
  candidates: number;
  /** Review calls actually made (one per candidate mention). */
  reviewed: number;
  /** Earlier pages actually modified. */
  modified: number;
  /** Links added to earlier pages. */
  linksAdded: number;
  /** What the model answered, and how often an answer could not be read. */
  verdicts: { accepted: number; refused: number; unusable: number };
  /** Candidates dropped by a bound, per reason. */
  truncated: Record<LinkReviewTruncationReason, number>;
}

/**
 * Where the stage reads and writes.
 *
 * The seams travel as ONE object because they always come from one place -- the
 * run's {@link PageSeams} -- and a caller that threaded three of the four would read
 * rows while writing files, or write into a batch another batch already opened.
 */
export interface LinkReviewOptions {
  /** The run's page seams; omitted reads and writes `wiki/concepts` on disk. */
  seams?: LinkReviewSeams;
}

/** The four seams this stage needs, all of which a compile already resolved. */
export interface LinkReviewSeams {
  /** Row-backed page reader, or undefined for `wiki/concepts`. */
  readonly content?: PageContentSource;
  /** Row writer, or undefined to write files. */
  readonly sink?: PageSink;
  /** Row remover, carried so both page seams travel together. */
  readonly remover?: PageRemover;
  /** Open batch the writes join, when the caller has one. */
  readonly transaction?: PageBatchTransaction;
}

/** An earlier page of the wiki, with the text a link must anchor to. */
interface EarlierPage {
  slug: string;
  title: string;
  content: string;
  body: string;
}

/** One candidate: an earlier page's real mention of one article. */
interface Candidate {
  page: EarlierPage;
  article: LinkReviewArticle;
  /** The words of the mention, exactly as the page writes them. */
  text: string;
}

/** One page being edited, with its accumulating body. */
interface EditInProgress {
  page: EarlierPage;
  body: string;
}

/** Counts with nothing reviewed yet. */
export function emptyLinkReviewCounts(): LinkReviewCounts {
  return {
    articles: 0,
    candidates: 0,
    reviewed: 0,
    modified: 0,
    linksAdded: 0,
    verdicts: { accepted: 0, refused: 0, unusable: 0 },
    truncated: { "article-cap": 0, "run-cap": 0, "modify-cap": 0 },
  };
}

/**
 * Fold one stage run's counts into a compile's running total.
 *
 * @param total - The run's total, mutated in place.
 * @param counts - What one invocation of {@link reviewEarlierPages} decided.
 */
export function addLinkReviewCounts(total: LinkReviewCounts, counts: LinkReviewCounts): void {
  total.articles += counts.articles;
  total.candidates += counts.candidates;
  total.reviewed += counts.reviewed;
  total.modified += counts.modified;
  total.linksAdded += counts.linksAdded;
  total.verdicts.accepted += counts.verdicts.accepted;
  total.verdicts.refused += counts.verdicts.refused;
  total.verdicts.unusable += counts.verdicts.unusable;
  for (const reason of TRUNCATION_REASONS) total.truncated[reason] += counts.truncated[reason];
}

/** Whether a bound dropped anything, which makes the report line a warning. */
export function hasLinkReviewTruncation(counts: LinkReviewCounts): boolean {
  return TRUNCATION_REASONS.some((reason) => counts.truncated[reason] > 0);
}

/**
 * One line describing what the review did, or null when it did nothing at all.
 *
 * Silence means the stage found no candidate, reviewed nothing and dropped
 * nothing -- the normal case for an ingest of a wiki that already knows the new
 * article. A limit that fired is never silent (S12), and each truncated reason is
 * named with its own count so an operator can tell which bound to raise.
 *
 * @param counts - The run's totals for this stage.
 * @returns The summary text, or null when there is nothing to report.
 */
export function describeLinkReview(counts: LinkReviewCounts): string | null {
  if (counts.reviewed === 0 && !hasLinkReviewTruncation(counts)) return null;
  const parts = [
    `${counts.reviewed} review(s) of ${counts.candidates} earlier page(s)`,
    `${counts.linksAdded} link(s) added in ${counts.modified} page(s)`,
  ];
  if (counts.verdicts.refused > 0) parts.push(`${counts.verdicts.refused} refused`);
  if (counts.verdicts.unusable > 0) parts.push(`${counts.verdicts.unusable} unusable verdict(s)`);
  const refused = TRUNCATION_REASONS.filter((reason) => counts.truncated[reason] > 0);
  if (refused.length > 0) {
    parts.push(`truncated ${refused.map((reason) => `${counts.truncated[reason]} ${reason}`).join(", ")}`);
  }
  return parts.join(", ");
}

/**
 * Review the wiki's earlier pages for a reference to the articles this run wrote.
 *
 * @param root - Project root the reads and writes are confined under.
 * @param articles - Articles created or updated by this run.
 * @param options - Where to read and write, and the run's page seams.
 * @returns What this run of the stage reviewed, changed and truncated.
 */
export async function reviewEarlierPages(
  root: string,
  articles: readonly LinkReviewArticle[],
  options: LinkReviewOptions = {},
): Promise<LinkReviewCounts> {
  const counts = emptyLinkReviewCounts();
  counts.articles = articles.length;
  if (articles.length === 0) return counts;
  const named = await withDeclaredAliases(root, articles, options.seams?.content);
  const earlier = await loadEarlierPages(root, named, options.seams?.content);
  const candidates = collectCandidates(named, earlier, counts);
  if (candidates.length === 0) return counts;
  const pageSet = await listLinkPageSet(root, options.seams?.content);
  const edits = await decideEdits(candidates, pageSet, counts);
  await applyEdits(root, edits, counts, options);
  return counts;
}

/** Every concept slug of the wiki, in listing order. */
async function listConceptSlugs(
  root: string,
  source: PageContentSource | undefined,
): Promise<string[]> {
  if (source !== undefined) return await source.listSlugs("concepts");
  const files = await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -".md".length));
}

/**
 * Read the pages that existed BEFORE this run, in a deterministic order.
 *
 * Slug order, not listing order: the per-article cap has to keep the same
 * candidates when it truncates, and a directory listing is not a promise about
 * order. The run's own articles are excluded -- they are the targets, not
 * candidates -- and so are orphaned pages, which the wiki no longer serves.
 *
 * @param root - Project root the reads are confined under.
 * @param articles - This run's articles, to exclude from the candidate set.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The earlier pages, by slug.
 */
async function loadEarlierPages(
  root: string,
  articles: readonly LinkReviewArticle[],
  source: PageContentSource | undefined,
): Promise<EarlierPage[]> {
  const written = new Set(articles.map((article) => article.slug));
  const slugs = (await listConceptSlugs(root, source))
    .filter((slug) => !written.has(slug))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const pages: EarlierPage[] = [];
  for (const slug of slugs) {
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, slug, source);
    if (content === "") continue;
    const { meta, body } = parseFrontmatter(content);
    if (meta.orphaned) continue;
    const title = typeof meta.title === "string" && meta.title !== "" ? meta.title : slug;
    pages.push({ slug, title, content, body });
  }
  return pages;
}

/**
 * This run's articles, each carrying every name its STORED page already declares.
 *
 * The identity stage folds aliases during THIS run and hands them over on the article,
 * but the page also PERSISTS the names an earlier ingest resolved -- that persistence
 * is what makes identity deterministic across runs, and it is worthless if retrieval
 * ignores it: a page that has called the concept by an established synonym for ten
 * runs would never be considered for a reference to it.
 *
 * The union is deduped by canonical key, so a name spelled twice, or a generated alias
 * that is only a case variant of another, is offered once. The title is never repeated
 * as its own alias, because a self-alias would make the mention scan match one name
 * twice for no gain.
 *
 * A page whose stored frontmatter cannot be read contributes no declared aliases: the
 * run's own folded names still apply, and a missing page is not a failure here.
 *
 * @param root - Project root the reads are confined under.
 * @param articles - This run's articles, with the names folded during this run.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The same articles, with their declared aliases merged in.
 */
async function withDeclaredAliases(
  root: string,
  articles: readonly LinkReviewArticle[],
  source: PageContentSource | undefined,
): Promise<LinkReviewArticle[]> {
  const named: LinkReviewArticle[] = [];
  for (const article of articles) {
    // warnAlways=false: an article the run could not read back is a normal absence
    // here, not a dropped page worth a warning on every ingest.
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, article.slug, source, false);
    const declared = content === "" ? [] : aliasNames(parseFrontmatter(content).meta.aliases);
    named.push({ ...article, aliases: extraNames(article.title, article.aliases, declared) });
  }
  return named;
}

/** The plain strings a frontmatter `aliases` value may hold. */
function aliasNames(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

/**
 * Every extra name an article answers to, in first-seen order, title excluded.
 *
 * Names folded during this run come before the ones persisted earlier, so the most
 * recently resolved synonym is the one the mention scan tries first.
 *
 * @param title - The article's canonical title, which is matched separately.
 * @param folded - Names this run's identity stage folded into the article.
 * @param declared - Names the stored page declares in its frontmatter.
 * @returns Deduplicated names, none of which is the title itself.
 */
function extraNames(
  title: string,
  folded: readonly string[],
  declared: readonly string[],
): string[] {
  const seen = new Set<string>([canonicalConceptKey(title)]);
  const names: string[] = [];
  for (const raw of [...folded, ...declared]) {
    const name = raw.trim();
    const key = canonicalConceptKey(name);
    if (name === "" || key === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** The names a page may use for an article, most canonical first. */
function namesOf(article: LinkReviewArticle): string[] {
  return [article.title, ...article.aliases].filter((name) => name.trim() !== "");
}

/**
 * The candidate mentions this run may review, bounded per article and per run.
 *
 * @param articles - This run's articles.
 * @param earlier - The wiki's earlier pages, by slug.
 * @param counts - Totals to fill with the candidate and truncation counts.
 * @returns Candidates in review order: article order, then page slug.
 */
function collectCandidates(
  articles: readonly LinkReviewArticle[],
  earlier: readonly EarlierPage[],
  counts: LinkReviewCounts,
): Candidate[] {
  const candidates: Candidate[] = [];
  const pages = new Set<string>();
  for (const article of articles) {
    let taken = 0;
    for (const page of earlier) {
      const mention = firstPlainMention(page.body, namesOf(article));
      if (mention === null) continue;
      if (taken >= MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE) {
        counts.truncated["article-cap"] += 1;
        continue;
      }
      if (candidates.length >= MAX_LINK_REVIEW_PAGES_PER_RUN) {
        counts.truncated["run-cap"] += 1;
        continue;
      }
      taken += 1;
      pages.add(page.slug);
      candidates.push({ page, article, text: mention.text });
    }
  }
  counts.candidates = pages.size;
  return candidates;
}

/** A real mention on a page: the words, and exactly where they are. */
interface PlainMention {
  /** The matched text, exactly as the page writes it. */
  text: string;
  start: number;
  end: number;
}

/** The first plain mention of any of `names` in a body, as the page writes it. */
function firstPlainMention(body: string, names: readonly string[]): PlainMention | null {
  const spans = unlinkableSpans(body);
  const literal = isLiteralMarkdown(body);
  for (const name of names) {
    const found = firstPlainOccurrence(body, name, spans, literal);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The first occurrence of `name` that a link could really anchor to.
 *
 * Skipped: anything inside an existing wikilink (it is already a link), inside a
 * citation marker (provenance, not prose), inside literal Markdown (a code example
 * is not a link target), and any occurrence that is part of a longer word -- so
 * "Vector Database" is not "found" inside "Vector Databases", which would put a
 * link in the middle of a word.
 *
 * @param body - The page body.
 * @param name - The title or alias to look for.
 * @param spans - Offsets that cannot hold a link.
 * @param literal - Predicate for offsets inside literal Markdown.
 * @returns The mention and its span, or null when the page only names it unusably.
 */
function firstPlainOccurrence(
  body: string,
  name: string,
  spans: readonly Span[],
  literal: (offset: number) => boolean,
): PlainMention | null {
  const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  for (const match of body.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isInside(spans, start) || literal(start) || !isWordBounded(body, start, end)) continue;
    return { text: match[0], start, end };
  }
  return null;
}

/** A half-open range of body offsets. */
interface Span {
  start: number;
  end: number;
}

/** Offsets that belong to an existing link or a citation marker. */
function unlinkableSpans(body: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of [WIKILINK_PATTERN, CITATION_PATTERN]) {
    for (const match of body.matchAll(pattern)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

/** True when `offset` falls inside any span (`literal` is checked separately). */
function isInside(spans: readonly Span[], offset: number): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}

/** True when neither end of the match is glued to a letter or digit. */
function isWordBounded(body: string, start: number, end: number): boolean {
  const word = /[\p{L}\p{N}_]/u;
  const before = start === 0 || !word.test(body[start - 1] ?? "");
  const after = end >= body.length || !word.test(body[end] ?? "");
  return before && after;
}

/**
 * Judge each candidate and edit the accepted ones, honouring the modify cap.
 *
 * Reviews happen for every candidate; only WRITES are capped, because the cap that
 * protects the wiki is the write budget, and a review that was paid for should still
 * tell the run what the model thought.
 *
 * @param candidates - The bounded candidate list, in review order.
 * @param pageSet - This wiki's page set, for the final gate.
 * @param counts - Totals to fill.
 * @returns One edit per page whose body changed, in candidate order.
 */
async function decideEdits(
  candidates: readonly Candidate[],
  pageSet: Awaited<ReturnType<typeof listLinkPageSet>>,
  counts: LinkReviewCounts,
): Promise<ReviewEdit[]> {
  const edited = new Map<string, EditInProgress>();
  for (const candidate of candidates) {
    const mention = await reviewCandidate(candidate, counts);
    if (mention === null) continue;
    const state = edited.get(candidate.page.slug)
      ?? { page: candidate.page, body: candidate.page.body };
    const body = wrapMention(state.body, mention, candidate.article.slug);
    if (body === null) {
      counts.verdicts.unusable += 1;
      continue;
    }
    if (!edited.has(state.page.slug) && edited.size >= MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN) {
      counts.truncated["modify-cap"] += 1;
      continue;
    }
    edited.set(state.page.slug, { page: state.page, body });
  }
  return await gateEdits([...edited.values()], pageSet);
}

/**
 * Ask the model about one candidate.
 *
 * @param candidate - The page, the article and the words of the mention.
 * @param counts - Totals to fill with the review and verdict counts.
 * @returns The words to link, or null when the link was refused or unusable.
 */
async function reviewCandidate(
  candidate: Candidate,
  counts: LinkReviewCounts,
): Promise<string | null> {
  counts.reviewed += 1;
  const verdict = await requestVerdict(candidate);
  if (verdict === null) {
    counts.verdicts.unusable += 1;
    return null;
  }
  if (!verdict.shouldLink) {
    counts.verdicts.refused += 1;
    return null;
  }
  counts.verdicts.accepted += 1;
  const quoted = verdict.mention.trim();
  return quoted === "" ? candidate.text : quoted;
}

/**
 * One review call. A provider failure is an unusable verdict, never a failed
 * compile: this stage improves the wiki, it is not a precondition for publishing it.
 *
 * @param candidate - The candidate being judged.
 * @returns The parsed verdict, or null when the answer could not be read.
 */
async function requestVerdict(candidate: Candidate): Promise<ReturnType<typeof parseLinkVerdict>> {
  const system = buildLinkReviewPrompt({
    pageTitle: candidate.page.title,
    passage: passageAround(candidate.page.body, candidate.text),
    articleTitle: candidate.article.title,
    articleSummary: "",
  });
  try {
    const raw = await callClaude({
      system,
      messages: [{
        role: "user",
        content: `Should "${candidate.page.title}" link its mention of "${candidate.article.title}"?`,
      }],
      tools: [LINK_REVIEW_TOOL],
      maxTokens: 512,
    });
    return parseLinkVerdict(raw);
  } catch {
    return null;
  }
}

/** The paragraph holding a mention, so the model sees the sentence in context. */
function passageAround(body: string, text: string): string {
  const offset = body.toLowerCase().indexOf(text.toLowerCase());
  if (offset === -1) return body;
  const start = body.lastIndexOf("\n\n", offset) + 2;
  const end = body.indexOf("\n\n", offset + text.length);
  return body.slice(start, end === -1 ? body.length : end).trim();
}

/**
 * Wrap one mention in link markup, changing no other byte.
 *
 * @param body - The body as it stands (possibly already edited by an earlier verdict).
 * @param mention - The words to link, as the verdict quoted them.
 * @param slug - The article's slug, which is the link target.
 * @returns The edited body, or null when the page no longer holds a plain mention.
 */
function wrapMention(body: string, mention: string, slug: string): string | null {
  const found = firstPlainMention(body, [mention]);
  if (found === null) return null;
  return `${body.slice(0, found.start)}[[${slug}|${found.text}]]${body.slice(found.end)}`;
}

/** A page changed by the review, and how many links it gained. */
interface ReviewEdit {
  write: CompilePageWrite;
  linksAdded: number;
}

/**
 * Judge every edited body through the ONE final link gate, and keep only the bodies
 * it accepts.
 *
 * This is what stops the stage from being a second, laxer channel: the link it adds
 * is anchored, unique, in budget and not a self-reference by the same rules as any
 * other link. A body the gate leaves equal to the page's own body produces no write.
 *
 * @param edits - The pages whose body the model's verdicts changed.
 * @param pageSet - This wiki's page set.
 * @returns One edit per page that really changed.
 */
async function gateEdits(
  edits: readonly EditInProgress[],
  pageSet: Awaited<ReturnType<typeof listLinkPageSet>>,
): Promise<ReviewEdit[]> {
  const kept: ReviewEdit[] = [];
  for (const edit of edits) {
    const index = linkIndexFor(pageSet, { id: `concepts/${edit.page.slug}`, title: edit.page.title });
    const validated = await validateContextualLinks(edit.body, index);
    const linksAdded = countLinks(validated.body) - countLinks(edit.page.body);
    if (linksAdded <= 0) continue;
    kept.push({
      write: {
        namespace: "concepts",
        slug: edit.page.slug,
        // A replacement FUNCTION, not a string: page prose containing `$&` or `$$`
        // must never be reinterpreted as a replacement pattern.
        body: edit.page.content.replace(edit.page.body, () => validated.body),
      },
      linksAdded,
    });
  }
  return kept;
}

/**
 * Apply the edits as ONE journalled batch through the trust-floored write path, and
 * count only what committed.
 *
 * A page the trust floor skipped is reported rather than counted: the run must not
 * claim a link it did not write.
 *
 * @param root - Project root the writes are confined under.
 * @param edits - The pages to write.
 * @param counts - Totals to fill with the committed modifications.
 * @param options - The run's write seams.
 */
async function applyEdits(
  root: string,
  edits: readonly ReviewEdit[],
  counts: LinkReviewCounts,
  options: LinkReviewOptions,
): Promise<void> {
  if (edits.length === 0) return;
  const { skipped } = await applyCompilePageWritesLocked(
    root,
    edits.map((edit) => edit.write),
    pageStoreOptions(options.seams?.sink, options.seams?.remover, options.seams?.transaction),
  );
  const skippedSlugs = new Set(skipped.map((item) => item.item.slug));
  for (const edit of edits) {
    if (skippedSlugs.has(edit.write.slug)) continue;
    counts.modified += 1;
    counts.linksAdded += edit.linksAdded;
  }
  for (const item of skipped) {
    output.status("!", output.warn(`Link review write skipped for "${item.item.slug}" — ${item.reason}`));
  }
}

/** The number of wikilinks in a page's markdown. */
function countLinks(content: string): number {
  return [...content.matchAll(WIKILINK_PATTERN)].length;
}
