/**
 * @file Incremental reference review of EARLIER pages when an article is written.
 *
 * THE REQUIREMENT (S9). "5 Revisar conceptos Al crear o actualizar un artículo,
 * recupera páginas anteriores que podrían necesitar una referencia hacia él.
 * Modifica esas páginas únicamente cuando el enlace tenga sentido en su contenido.
 * No reescribas toda la wiki durante cada ingestión." And S14: "similarity may
 * RETRIEVE candidates, it may never DECIDE ... link creation."
 *
 * ONE RESPONSIBILITY: STAGE ORCHESTRATION. This module drives one run of the stage --
 * it asks {@link reviewEarlierPages}' retrieval dependency for candidates, judges each
 * one, performs the surgical edit, gates the result and writes exactly the pages whose
 * text changed. Candidate retrieval lives in `link-review-candidates.ts`: the names an
 * article answers to, the plain-mention predicate and the bounded candidate list. This
 * module depends on that one and never the other way round.
 *
 * RETRIEVAL versus DECISION, stated separately because they are different mechanisms
 * and only one of them may guess:
 *
 *   - RETRIEVAL is deterministic and lexical, and it is not done here. An earlier page
 *     is a candidate exactly when its own text already names the article -- see
 *     `link-review-candidates.ts` for the three name sources and the mention rule.
 *     No embedding, no cosine score and no vector store is consulted anywhere in this
 *     stage, which is the strongest form of S14 available: nothing numeric can propose
 *     a link, because no metric is read.
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
 * line via {@link describeLinkReview}. The first two bounds are enforced where the
 * candidates are retrieved; the write budget is enforced here.
 *
 * SCOPE. Concept-namespace pages only: an article is a concept page, and the pages
 * that would reference it are the wiki's articles. Orphaned pages are skipped
 * because they are no longer served by the wiki.
 */

import { callClaude } from "../utils/llm.js";
import { buildLinkReviewPrompt, LINK_REVIEW_TOOL, parseLinkVerdict } from "./prompts.js";
import { linkIndexFor, listLinkPageSet, validateContextualLinks } from "./link-anchoring.js";
import { applyCompilePageWritesLocked, type CompilePageWrite } from "./compile-write.js";
import {
  collectCandidates,
  countWikilinks,
  firstPlainMention,
  loadEarlierPages,
  withDeclaredAliases,
  TRUNCATION_REASONS,
  type Candidate,
  type EarlierPage,
  type LinkReviewArticle,
  type LinkReviewTruncationReason,
  type PlainMention,
} from "./link-review-candidates.js";
import {
  pageStoreOptions,
  type PageBatchTransaction,
  type PageRemover,
  type PageSink,
} from "../trust/page-apply.js";
import { MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN } from "../utils/constants.js";
import {
  addCuratedLinkCounts,
  anchorAround,
  createCuratedLink,
  emptyCuratedLinkCounts,
  type CuratedLinkCounts,
  type CuratedLinkRecord,
  type CuratedLinkStorePort,
} from "./curated-links.js";
import { createFileCuratedLinkStore } from "./curated-links-store.js";
import * as output from "../utils/output.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";

export type { LinkReviewArticle, LinkReviewTruncationReason } from "./link-review-candidates.js";

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
  /**
   * The DURABLE side of this stage: records kept for the links it curated, and the
   * records its own anchor rule or a named bound refused to keep.
   *
   * A curated link is written into a page body that the next render replaces, so the
   * link itself is not durable -- this record is. Reporting it here means the review's
   * run line covers both halves of the same decision: what it added now, and what it
   * promised the wiki for later.
   */
  curated: CuratedLinkCounts;
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

/** The seams this stage needs, all of which a compile already resolved. */
export interface LinkReviewSeams {
  /** Row-backed page reader, or undefined for `wiki/concepts`. */
  readonly content?: PageContentSource;
  /** Row writer, or undefined to write files. */
  readonly sink?: PageSink;
  /** Row remover, carried so both page seams travel together. */
  readonly remover?: PageRemover;
  /** Open batch the writes join, when the caller has one. */
  readonly transaction?: PageBatchTransaction;
  /**
   * The run's curated-link store, or undefined for the confined file.
   *
   * Carried with the page seams because the records this stage keeps are promises about
   * the bodies those seams write: a run that wrote a row and kept the record on the
   * compiling host would answer "does this wiki have that link" differently per machine.
   */
  readonly curatedLinks?: CuratedLinkStorePort;
}

/** One page being edited, with its accumulating body and the records it earned. */
interface EditInProgress {
  page: EarlierPage;
  body: string;
  /** One durable record per curated link this page gained in this run. */
  records: CuratedLinkRecord[];
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
    curated: emptyCuratedLinkCounts(),
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
  addCuratedLinkCounts(total.curated, counts.curated);
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
 * The order below is the stage's contract: names are widened before pages are read
 * (a declared alias changes who is a candidate), candidates are collected before the
 * gate's page set is listed (a run with no candidate does no further I/O), and edits
 * are applied only after every verdict and the gate have had their say.
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
      ?? { page: candidate.page, body: candidate.page.body, records: [] };
    const linked = wrapMention(state.body, mention, candidate.article.slug);
    if (linked === null) {
      counts.verdicts.unusable += 1;
      continue;
    }
    if (!edited.has(state.page.slug) && edited.size >= MAX_LINK_REVIEW_PAGES_MODIFIED_PER_RUN) {
      counts.truncated["modify-cap"] += 1;
      continue;
    }
    edited.set(state.page.slug, {
      page: state.page,
      body: linked.body,
      records: [...state.records, curatedRecordFor(candidate, linked.mention)],
    });
  }
  return await gateEdits([...edited.values()], pageSet);
}

/**
 * The durable record one accepted verdict earns.
 *
 * Both identities are RESOLVED page ids, never the spelling the model wrote: the link
 * target is the article's canonical slug, which is what the record has to re-create even
 * after `link-repair` has canonicalised every written target in the wiki. The anchor is
 * the mention the page really contains, with the prose around it, so a later render can
 * re-find it and a human can see what justified the link.
 *
 * @param candidate - The earlier page and the article it mentions.
 * @param mention - The span the accepted wording occupies in the page's body.
 * @returns The record to store once the page write commits.
 */
function curatedRecordFor(
  candidate: Candidate,
  mention: PlainMention,
): CuratedLinkRecord {
  return createCuratedLink({
    sourcePageId: `concepts/${candidate.page.slug}`,
    targetPageId: `concepts/${candidate.article.slug}`,
    anchor: anchorAround(candidate.page.body, mention),
    provenance: "model-verdict",
  });
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
 * No explicit `maxTokens`: the operator's configured output budget applies, exactly
 * as it does to extraction, page generation and category assignment. Pinning a
 * smaller number here would make one phase of the compile silently ignore
 * `LLMWIKI_MAX_TOKENS` -- the shared resolver in `src/utils/llm.ts` lets an explicit
 * value win, so the pinned number would be the only one this request ever had.
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
 * @returns The edited body with the span it linked, or null when the page no longer
 *   holds a plain mention.
 */
function wrapMention(
  body: string,
  mention: string,
  slug: string,
): { body: string; mention: PlainMention } | null {
  const found = firstPlainMention(body, [mention]);
  if (found === null) return null;
  return {
    body: `${body.slice(0, found.start)}[[${slug}|${found.text}]]${body.slice(found.end)}`,
    mention: found,
  };
}

/** A page changed by the review, and the durable records its links earn. */
interface ReviewEdit {
  write: CompilePageWrite;
  linksAdded: number;
  records: readonly CuratedLinkRecord[];
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
    const linksAdded = countWikilinks(validated.body) - countWikilinks(edit.page.body);
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
      records: edit.records,
    });
  }
  return kept;
}

/**
 * The curated-link store this stage keeps its records in.
 *
 * The run's own answer when a compile resolved one, and the confined file otherwise --
 * the same fallback `pageStoreOptions` makes for the page writes, so a caller that hands
 * the stage nothing keeps today's behaviour byte for byte.
 *
 * @param root - Project root the file backend is confined under.
 * @param seams - The run's seams, when a compile supplied them.
 * @returns The store to keep records in.
 */
function curatedStoreFor(
  root: string,
  seams: LinkReviewSeams | undefined,
): CuratedLinkStorePort {
  return seams?.curatedLinks ?? createFileCuratedLinkStore(root);
}

/**
 * Apply the edits as ONE journalled batch through the trust-floored write path, and
 * count only what committed.
 *
 * A page the trust floor skipped is reported rather than counted: the run must not
 * claim a link it did not write. Only the COMMITTED pages' records are stored, so the
 * store can never promise a link the wiki does not have -- and they go to the store the
 * page write went to, chosen once for the run by {@link LinkReviewSeams}.
 *
 * @param root - Project root the file backend is confined under.
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
  const records: CuratedLinkRecord[] = [];
  for (const edit of edits) {
    if (skippedSlugs.has(edit.write.slug)) continue;
    counts.modified += 1;
    counts.linksAdded += edit.linksAdded;
    records.push(...edit.records);
  }
  await curatedStoreFor(root, options.seams).record(records, counts.curated);
  for (const item of skipped) {
    output.status("!", output.warn(`Link review write skipped for "${item.item.slug}" — ${item.reason}`));
  }
}
