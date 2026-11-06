/**
 * @file Candidate RETRIEVAL for the incremental reference review (S9, S14).
 *
 * ONE RESPONSIBILITY. This module answers exactly two questions: WHICH earlier pages
 * of the wiki may receive a reference to an article this run wrote, and WHERE in such
 * a page the reference would anchor. It decides no link, calls no model, reads no
 * embedding and writes no page. The stage that judges and applies a link is
 * `link-review.ts`, and it consumes this module's candidate list; nothing here
 * depends on it back.
 *
 * THE RETRIEVAL RULE IS DETERMINISTIC AND LEXICAL. An earlier page is a candidate for
 * an article exactly when its own text already contains one of that article's NAMES
 * as a PLAIN mention -- not inside an existing `[[link]]`, not inside a `^[citation]`
 * marker (provenance, not prose), not inside a literal code span, and not glued to a
 * longer word, so "Vector Database" is not "found" inside "Vector Databases". That is
 * a hard precondition rather than a hint: a link needs words on the page to anchor it,
 * so a page that never names the article cannot receive one, however similar the two
 * topics are.
 *
 * THE NAMES ARE THREE SOURCES, UNIONED. A synonym resolved by an EARLIER ingest is
 * still a real name of the concept today, so the names an article answers to are its
 * canonical title, the aliases the identity stage folded during THIS run, and the
 * `aliases` its stored frontmatter already declares (see {@link withDeclaredAliases},
 * and {@link extraNames} for the dedupe).
 *
 * NOTHING NUMERIC PROPOSES A LINK. No embedding, no cosine score and no vector store
 * is consulted here. That is the strongest form of S14 -- "similarity may RETRIEVE
 * candidates, it may never DECIDE ... link creation" -- available: a metric cannot
 * propose a candidate because no metric is read.
 *
 * THE BOUNDS ARE NAMED AND COUNTED. {@link collectCandidates} honours
 * `MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE` and `MAX_LINK_REVIEW_PAGES_PER_RUN` from
 * `constants.ts` and counts what each one dropped under `article-cap` and `run-cap`,
 * so a truncated retrieval is never silent (S12).
 *
 * READING ORDER MATTERS AND IS FIXED. Earlier pages arrive in slug order, not listing
 * order, because a cap that truncates must keep the same candidates on every run; a
 * directory listing is not a promise about order.
 */

import { readdir } from "fs/promises";
import path from "path";
import { parseFrontmatter } from "../utils/markdown.js";
import { isLiteralMarkdown } from "./link-repair-code.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import {
  CONCEPTS_DIR,
  MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE,
  MAX_LINK_REVIEW_PAGES_PER_RUN,
} from "../utils/constants.js";
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

/**
 * The truncation reasons, in reporting order.
 *
 * The first two are this module's retrieval bounds; `modify-cap` belongs to the
 * write budget of `link-review.ts`. They live here because both modules count into
 * the same tally and the order is part of what a report reads out.
 */
export const TRUNCATION_REASONS: readonly LinkReviewTruncationReason[] = [
  "article-cap",
  "run-cap",
  "modify-cap",
];

/**
 * What candidate retrieval contributes to a run's counts.
 *
 * A narrow structural slice of the stage's wider `LinkReviewCounts` rather than the
 * whole record: retrieval reports the candidates it found and the candidates its own
 * bounds dropped, and knows nothing about reviews, verdicts or writes.
 */
export interface CandidateTally {
  /** Distinct earlier pages that really mentioned one of this run's articles. */
  candidates: number;
  /** Candidates dropped by a bound, per reason. */
  truncated: Record<LinkReviewTruncationReason, number>;
}

/** An earlier page of the wiki, with the text a link must anchor to. */
export interface EarlierPage {
  slug: string;
  title: string;
  content: string;
  body: string;
}

/** One candidate: an earlier page's real mention of one article. */
export interface Candidate {
  page: EarlierPage;
  article: LinkReviewArticle;
  /** The words of the mention, exactly as the page writes them. */
  text: string;
}

/** A real mention on a page: the words, and exactly where they are. */
export interface PlainMention {
  /** The matched text, exactly as the page writes it. */
  text: string;
  start: number;
  end: number;
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
export async function loadEarlierPages(
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
 * The union is deduped by LITERAL SPELLING, so a name spelled twice -- or a generated
 * alias that is only a case variant of another -- is offered once, while a spelling the
 * title's canonical key happens to fold is still offered, because the mention scan
 * matches literally and would otherwise never see it (see {@link extraNames}). The title
 * is never repeated as its own alias, because a self-alias would make the mention scan
 * match one name twice for no gain.
 *
 * A page whose stored frontmatter cannot be read contributes no declared aliases: the
 * run's own folded names still apply, and a missing page is not a failure here.
 *
 * @param root - Project root the reads are confined under.
 * @param articles - This run's articles, with the names folded during this run.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The same articles, with their declared aliases merged in.
 */
export async function withDeclaredAliases(
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
 * DEDUPLICATED ON THE LITERAL SPELLING, NOT ON THE CANONICAL KEY. That distinction is
 * the whole function. The canonical key folds case, expands a reviewed acronym list
 * (`db` -> `database`, `rag`, `llm`, ...) and stems plurals, which is exactly the rule
 * that decides that two spellings are the SAME CONCEPT -- so it is the wrong rule for
 * deciding whether two spellings are the same NAME. The mention scan this list feeds
 * matches LITERALLY (see {@link firstPlainMention}), so a key that folds two distinct
 * spellings together discards the one an earlier page actually writes: an article
 * titled `Vector DB` with the folded alias `Vector Database` had its alias dropped as a
 * "duplicate" of the title, and a page naming it `Vector Database` -- the precise
 * spelling -- was never offered for review at all.
 *
 * Two names that differ only in case or spacing ARE the same mention, because the scan
 * is case-insensitive, so the dedupe key is the trimmed, whitespace-collapsed, lower-
 * cased spelling. The title's own key is pre-seeded, so the title is still never
 * repeated as its own alias, which is what keeps one page from being matched twice for
 * the same words.
 *
 * Names folded during this run come before the ones persisted earlier, so the most
 * recently resolved synonym is the one the mention scan tries first.
 *
 * @param title - The article's canonical title, which is matched separately.
 * @param folded - Names this run's identity stage folded into the article.
 * @param declared - Names the stored page declares in its frontmatter.
 * @returns Deduplicated names, none of which is a case or spacing variant of the title.
 */
function extraNames(
  title: string,
  folded: readonly string[],
  declared: readonly string[],
): string[] {
  const seen = new Set<string>([mentionKey(title)]);
  const names: string[] = [];
  for (const raw of [...folded, ...declared]) {
    const name = raw.trim();
    const key = mentionKey(name);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * The key two NAMES are deduplicated on: the spelling the mention scan would compare.
 *
 * Case and internal whitespace collapse because {@link firstPlainOccurrence} compiles its
 * pattern case-insensitively and whitespace is literal, so `Vector  Database` and
 * `vector database` can only ever match the same words. Nothing else is folded: any
 * further normalisation would discard a spelling the page can really contain.
 *
 * @param name - A title or alias as an article reports it.
 * @returns Its comparable spelling, or `""` when it carries no characters.
 */
function mentionKey(name: string): string {
  return name.trim().replace(/\s+/gu, " ").toLowerCase();
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
 * @param tally - Totals to fill with the candidate and truncation counts.
 * @returns Candidates in review order: article order, then page slug.
 */
export function collectCandidates(
  articles: readonly LinkReviewArticle[],
  earlier: readonly EarlierPage[],
  tally: CandidateTally,
): Candidate[] {
  const candidates: Candidate[] = [];
  const pages = new Set<string>();
  for (const article of articles) {
    let taken = 0;
    for (const page of earlier) {
      const mention = firstPlainMention(page.body, namesOf(article));
      if (mention === null) continue;
      if (taken >= MAX_LINK_REVIEW_CANDIDATES_PER_ARTICLE) {
        tally.truncated["article-cap"] += 1;
        continue;
      }
      if (candidates.length >= MAX_LINK_REVIEW_PAGES_PER_RUN) {
        tally.truncated["run-cap"] += 1;
        continue;
      }
      taken += 1;
      pages.add(page.slug);
      candidates.push({ page, article, text: mention.text });
    }
  }
  tally.candidates = pages.size;
  return candidates;
}

/** The first plain mention of any of `names` in a body, as the page writes it. */
export function firstPlainMention(body: string, names: readonly string[]): PlainMention | null {
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
 * The number of wikilinks in a page's markdown.
 *
 * Lives here because this module owns what counts as a link in a body: the same
 * `WIKILINK_PATTERN` that excludes an existing link from the mention scan is what
 * counts links for the stage's "how many did this edit add" accounting.
 *
 * @param content - A page body or a whole page.
 * @returns How many `[[...]]` links it contains.
 */
export function countWikilinks(content: string): number {
  return [...content.matchAll(WIKILINK_PATTERN)].length;
}
