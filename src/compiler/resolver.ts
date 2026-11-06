/**
 * Interlink resolution for wiki pages.
 *
 * Rule-based (not LLM-based) pass that scans wiki pages for concept title
 * mentions and wraps them in [[slug|Title]] wikilinks. The piped alias form
 * keeps Obsidian link resolution stable when a page's filename (slug) differs
 * from its display title.
 *
 * Complexity: O(changed * total) per incremental compile.
 * Full recompile degrades to O(total^2).
 *
 * THIS IS WHERE THE ONE FINAL LINK GATE RUNS. Links reach a page body through two
 * channels — the model types them inline, and {@link resolveLinks} wraps plain-text
 * mentions of real page titles — so the only place both are already in the body is
 * the link phase, immediately before `finalizeWiki` writes it. Every body this
 * module would write therefore passes {@link validateContextualLinks} first, which
 * is what makes the model's links and the resolver's links subject to ONE decision
 * table, ONE per-page budget and ONE set of counters. It also fixes what a gate at
 * generation time could not: the run's own pages are written before this phase, so
 * a link to a page the same run is creating resolves instead of being demoted as a
 * missing target.
 */

import { readdir } from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { parseFrontmatter } from "../utils/markdown.js";
import { readWikiPageContentOrWarn } from "./confined-wiki-read.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import {
  knownLinkPageSet,
  linkIndexFor,
  listLinkPageSet,
  reportContextualLinkCounts,
  uniqueTitleMap,
  validateContextualLinks,
} from "./link-anchoring.js";
import {
  pageStoreOptions,
  type PageBatchTransaction,
  type PageRemover,
  type PageSink,
} from "../trust/page-apply.js";
import { applyCompilePageWritesLocked } from "./compile-write.js";
import type { CompilePageNamespace, CompilePageWrite } from "./compile-write.js";
import { createRepairResolver } from "./link-repair.js";
import { listLinkResolvablePendingSlugs } from "./candidate-read.js";
import { applyCuratedOverlay } from "./curated-links-apply.js";
import type { ContextualLinkCounts, KnownPageIdentity, LinkPageSet } from "./link-anchoring.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import * as output from "../utils/output.js";

/**
 * Where link resolution reads page bodies from.
 *
 * Resolution is READ-MODIFY-WRITE inside the compile: it needs each page's current
 * text to decide whether a title mention should become a wikilink, and it needs the
 * same text back to rewrite it. When pages are rows that text never touches disk, so
 * the source supplies BOTH the identity and the bytes -- splitting them would let the
 * index come from rows while the rewrite read a file.
 */
export interface ResolverPageSource {
  /**
   * Every concept page with the text needed to rewrite it.
   *
   * @returns Each page's slug, title, full markdown (frontmatter included) and body.
   */
  listConcepts(): Promise<ResolverPage[]>;
}

/** One page as resolution sees it. */
export interface ResolverPage {
  /** Bare slug stem. */
  slug: string;
  /** Frontmatter title, used to find mentions. */
  title: string;
  /** Full markdown, frontmatter included -- the text that gets rewritten. */
  content: string;
  /** The body within `content`, so a rewrite replaces only the prose. */
  body: string;
  /**
   * Other names the page declares for itself, when the backend reports them.
   *
   * Optional rather than required so a source that cannot report aliases keeps
   * working; the link gate then anchors on titles only for those pages.
   */
  aliases?: readonly string[];
}

/**
 * What the final link gate judges against, and where its verdicts are collected.
 *
 * Grouped into one optional parameter so adding the gate did not add a fourth
 * positional argument a caller could transpose with another.
 */
export interface LinkGateOptions {
  /**
   * Row-backed page reader, when this run's corpus lives in rows.
   *
   * Supplied by the compile path so the gate sees every page of every namespace —
   * including a `queries` target, which the title index (concepts only) does not
   * list. When it is absent the gate lists whatever backend the run itself reads:
   * `wiki/` for a file-backed run, and the pages this phase already enumerated for a
   * row-backed one. See {@link linkPageSetFor}.
   */
  pageContent?: PageContentSource;
  /** Collector for the run's aggregate counts, so one line can summarize them. */
  sink?: LinkGateSink;
}

/** How a run collects the link gate's per-page verdicts for its aggregate line. */
export interface LinkGateSink {
  /**
   * Record what the gate decided for one page.
   *
   * @param counts - What that page kept, and how many links each rule refused.
   */
  record: (counts: ContextualLinkCounts) => void;
}

/**
 * The final link gate's options, built in ONE place.
 *
 * WHY A SHARED CONSTRUCTION. Two callers assembling their own options is two
 * answers for the same link: `review approve` used to pass NO options, so its links
 * were judged against the pages the resolver had already enumerated -- the CONCEPT
 * namespace -- while a compile judged the same link against the run's whole corpus.
 * A page in `queries` was therefore a real target when a compile wrote the body and a
 * missing one when the approve verb wrote it. The wider page set is not a preference;
 * it is what "the target exists" means for this wiki, so every caller asks for it the
 * same way.
 *
 * `pageContent` is the seam the caller's pages were written through, so the page set
 * the gate reads cannot disagree with the corpus the caller just wrote. A caller with
 * no seam (a file-backed project) omits it and gets the gate's own fallback, which
 * lists `wiki/` in both namespaces -- see `linkPageSetFor`.
 *
 * @param pageContent - The caller's page-content seam, when its corpus lives in rows.
 * @param sink - Collector for the caller's aggregate counts, when it keeps totals.
 * @returns The options for {@link resolveLinks} / {@link resolveAndApplyLinks}.
 */
export function linkGateOptions(
  pageContent: PageContentSource | undefined,
  sink?: LinkGateSink,
): LinkGateOptions {
  return sink === undefined ? { pageContent } : { pageContent, sink };
}

interface PageInfo {
  /** Project root, carried so per-page writes stay confined to `wiki/concepts`. */
  root: string;
  slug: string;
  title: string;
  /**
   * Other names the page declares, so the link gate can accept them as anchors.
   *
   * Carried on the index entry rather than re-read at gate time: the gate judges a
   * body against the SAME text the index was built from, and a second read could
   * disagree with it.
   */
  aliases: readonly string[];
  filePath: string;
  /**
   * The body this page had BEFORE the curated-link overlay, when the overlay changed it.
   *
   * Only set on that path, and only for one reason: `collectFinalBodies` and
   * `rewritePage` decide whether to write by comparing their result with the body the
   * pass started from. After the overlay, `body` is the restored text, so without this
   * baseline a restored link would look like "nothing changed" and never be written on
   * the paths where the overlay is the only channel that restored it.
   */
  originalBody?: string;
  /**
   * The page's markdown as the index saw it.
   *
   * Carried rather than re-read: the row-backed source has no file to read back, and
   * a second read of the disk-backed path could pick up a version the title index
   * never saw -- rewriting a page against a body that does not match its own title.
   */
  content: string;
  /** The body within `content`. */
  body: string;
}

/**
 * Build an index of all wiki page titles from the concepts directory. Each page
 * is read through the confined helper, so a symlinked entry whose target escapes
 * `wiki/concepts` is dropped (warned, skipped) and never enters the title index
 * (so its bytes can never be re-emitted into a rewritten page).
 */
async function buildTitleIndex(
  root: string,
  source?: ResolverPageSource,
): Promise<PageInfo[]> {
  if (source !== undefined) return indexFromSource(root, await source.listConcepts());
  const conceptsDir = path.join(root, CONCEPTS_DIR);
  if (!existsSync(conceptsDir)) return [];

  const files = await readdir(conceptsDir);
  const pages: PageInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const slug = file.replace(/\.md$/, "");
    const content = await readWikiPageContentOrWarn(root, CONCEPTS_DIR, slug);
    if (!content) continue;
    const { meta, body } = parseFrontmatter(content);

    if (meta.title && typeof meta.title === "string" && !meta.orphaned) {
      pages.push({
        root,
        slug,
        title: meta.title,
        aliases: aliasList(meta.aliases),
        filePath: path.join(conceptsDir, file),
        content,
        body,
      });
    }
  }

  return pages;
}

/** Reduce a frontmatter value to the plain strings it may contain. */
function aliasList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

/**
 * Build the title index from pages a source supplied.
 *
 * The file path applies its own eligibility rule (a title is required and an orphaned
 * page is skipped); this applies the SAME rule to rows, so a page that could not be
 * linked from disk cannot be linked from the table either.
 *
 * @param root - Project root, carried on each entry for the confined write.
 * @param pages - Pages with their text, as the source reported them.
 * @returns Entries eligible for wikilink insertion.
 */
function indexFromSource(root: string, pages: ResolverPage[]): PageInfo[] {
  return pages
    .filter((page) => page.title !== "" && page.title.length > 0)
    .map((page) => ({
      root,
      slug: page.slug,
      title: page.title,
      aliases: page.aliases ?? [],
      filePath: path.join(root, CONCEPTS_DIR, `${page.slug}.md`),
      content: page.content,
      body: page.body,
    }));
}

/** Check if a position is inside an existing [[wikilink]]. */
function isInsideWikilink(text: string, position: number): boolean {
  const before = text.lastIndexOf("[[", position);
  const after = text.indexOf("]]", position);
  if (before === -1 || after === -1) return false;

  const closeBefore = text.indexOf("]]", before);
  return closeBefore >= position;
}

/** Check if a position is inside a ^[...] citation marker. */
function isInsideCitation(text: string, position: number): boolean {
  const before = text.lastIndexOf("^[", position);
  const after = text.indexOf("]", position);
  if (before === -1 || after === -1) return false;

  const closeBefore = text.indexOf("]", before);
  return closeBefore >= position;
}

/** Check if a match is at a word boundary. */
function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start === 0 || /[\s,.:;!?()\[\]{}/"']/.test(text[start - 1]);
  const after = end >= text.length || /[\s,.:;!?()\[\]{}/"']/.test(text[end]);
  return before && after;
}

/** Find all regex matches for a title in the text, returned as position spans. */
function findTitleMatches(text: string, title: string): { start: number; end: number }[] {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  const matches: { start: number; end: number }[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/** Determine whether a match position is eligible for wikilink insertion. */
function isLinkablePosition(text: string, start: number, end: number): boolean {
  if (isInsideWikilink(text, start)) return false;
  if (isInsideCitation(text, start)) return false;
  return isWordBoundary(text, start, end);
}

/**
 * Add [[wikilinks]] to a page's body for any title mentions.
 * Skips already-linked text and non-word-boundary matches.
 *
 * The page's own title is skipped here AND refused by the link gate. Both are the
 * same rule, kept in both places on purpose: this pass would otherwise produce a
 * self-link for every page that names itself, which the gate would then have to
 * strip from every page on every run — and the gate would still be right, because
 * it is the one that decides.
 */
function addWikilinks(body: string, titles: readonly PageInfo[], selfTitle: string): string {
  let result = body;
  const selfLower = selfTitle.toLowerCase();

  for (const page of titles) {
    if (page.title.toLowerCase() === selfLower) continue;

    const matches = findTitleMatches(result, page.title);

    // Process matches in reverse to preserve positions
    for (const m of matches.reverse()) {
      if (!isLinkablePosition(result, m.start, m.end)) continue;
      result = result.slice(0, m.start) + `[[${page.slug}|${page.title}]]` + result.slice(m.end);
    }
  }

  return result;
}

/**
 * COMPUTE interlink resolution for changed and affected pages, returning the
 * rewritten page bodies as {@link CompilePageWrite}s for the CALLER to apply as
 * ONE journalled resolution batch (instead of an inline `atomicWrite`).
 *
 * Two link channels feed one final body per page:
 * 1. Outbound: changed pages get [[wikilinks]] for any title they mention.
 * 2. Inbound: ALL pages get scanned for mentions of newly created titles.
 *    This ensures existing pages link to new concepts without a full recompile.
 *
 * THE DURABLE CURATED LINKS ARE RESTORED FIRST (see {@link restoreCuratedLinks}), so a
 * curated link is already in the body these two passes read. That ordering is a
 * correctness condition, not a preference: the overlay and the outbound pass both want
 * to claim a mention, and whichever runs second would otherwise wrap a link the first
 * one had just written.
 *
 * Every body either pass produces — and the body of every changed page the gate
 * must still judge for the links the MODEL wrote — goes through
 * {@link validateContextualLinks} before it becomes a write. A refused link is
 * reduced to its mention, so the page is written with the sentence intact.
 *
 * Complexity: O(changed * total) for outbound, O(newTitles * total) for inbound.
 * @param root - Absolute project root the reads and writes are confined under.
 * @param changedSlugs - Slugs whose pages get outbound links re-resolved.
 * @param newSlugs - Slugs created by this run, scanned for inbound mentions.
 * @param source - Row-backed page source, or undefined to read `wiki/concepts`.
 * @param gate - What the final gate judges against, and where its counts go.
 * @returns The rewritten pages (one per page whose body actually changed).
 */
export async function resolveLinks(
  root: string,
  changedSlugs: string[],
  newSlugs: string[],
  source?: ResolverPageSource,
  gate?: LinkGateOptions,
): Promise<CompilePageWrite[]> {
  const titleIndex = await buildTitleIndex(root, source);
  if (titleIndex.length === 0) return [];
  await restoreCuratedLinks(root, scopedPages(titleIndex, changedSlugs, newSlugs));
  const bodies = collectFinalBodies(titleIndex, changedSlugs, newSlugs);
  const writes = await gateFinalBodies(root, titleIndex, bodies, gate, source !== undefined);
  if (writes.length > 0) {
    output.status("🔗", output.dim(`Resolved links in ${writes.length} page(s)`));
  }
  return writes;
}

/**
 * Re-anchor this wiki's durable curated links onto the bodies about to be re-linked.
 *
 * WHY IT LIVES HERE, IN THE SHARED LINK PHASE. Not every caller of this module replaces
 * a body: `review approve` writes the body it stored when the candidate was generated,
 * and an OKF import writes the bodies it was given, so both can drop a curated link that
 * a compile restored. This phase is the one seam all three go through, and it composes
 * bodies before judging them, so applying the overlay here is what makes the rule hold
 * for every entry point instead of for the compile alone.
 *
 * It is IDEMPOTENT and therefore free on the ordinary compile path: a body generation
 * already restored carries the link, so the overlay finds it present and changes nothing.
 *
 * `page.originalBody` is what keeps the restored link from being a NO-OP WRITE. The
 * passes below decide whether to write by comparing their result against the body they
 * started from, so once `page.body` holds the restored link that comparison would say
 * "nothing changed" and the link would never reach disk on the paths where this overlay
 * is the only one that restored it. The pre-overlay body is carried as the baseline for
 * exactly that comparison.
 *
 * @param root - Absolute project root the store is confined under.
 * @param pages - The pages this phase must judge, mutated in place with their bodies.
 */
async function restoreCuratedLinks(root: string, pages: readonly PageInfo[]): Promise<void> {
  if (pages.length === 0) return;
  const batch = await applyCuratedOverlay(
    root, pages.map((page) => ({ pageId: pageIdOf(page), body: page.body })),
  );
  for (const page of pages) {
    const restored = batch.bodies.get(pageIdOf(page));
    if (restored === undefined || restored.body === page.body) continue;
    // The baseline the write decision and the substitution are both made against,
    // captured before the overlay. `content` is deliberately NOT rewritten: it is the
    // bytes read from disk, and a write substitutes the final prose into THEM, so the
    // gate's verdict on the restored link cannot be bypassed by an already-edited copy.
    page.originalBody = page.body;
    page.body = restored.body;
  }
}

/**
 * The pages this link phase must judge: the ones it wrote, plus the ones a new title
 * reaches. A page the run neither wrote nor changed is not here — see
 * {@link collectFinalBodies} for why re-judging the whole wiki per ingest is wrong.
 *
 * @param titleIndex - Every page the resolver can see.
 * @param changedSlugs - Slugs this run wrote.
 * @param newSlugs - Slugs this run created.
 * @returns The pages in scope, in index order.
 */
function scopedPages(
  titleIndex: readonly PageInfo[],
  changedSlugs: readonly string[],
  newSlugs: readonly string[],
): PageInfo[] {
  const changed = new Set(changedSlugs);
  const added = new Set(newSlugs);
  const hasNewTitles = titleIndex.some((page) => added.has(page.slug));
  return titleIndex.filter(
    (page) => changed.has(page.slug) || (hasNewTitles && !added.has(page.slug)),
  );
}

/** A page and the final body the link gate will judge. */
interface FinalBody {
  page: PageInfo;
  body: string;
}

/**
 * The final body of every page this phase must judge, keyed by slug.
 *
 * Two reasons a page is here. It was CHANGED, so its body carries whatever the
 * model typed and has to be gated even if neither resolver pass adds anything. Or
 * a resolver pass actually inserted a link into it, which includes pages this run
 * did not generate (the inbound pass) — those are gated because the link being added
 * is the resolver's, and the resolver is not above the rules.
 *
 * A page the run neither wrote nor changed is NOT here. Re-judging untouched pages
 * would rewrite the whole wiki on every ingest, and it would silently demote links
 * this run never had a reason to look at — including the prefix-shaped links
 * `link-repair` is about to canonicalise, which run after this phase.
 *
 * @param titleIndex - Every page the resolver can see.
 * @param changedSlugs - Slugs this run wrote.
 * @param newSlugs - Slugs this run created.
 * @returns The bodies to judge, in index order.
 */
function collectFinalBodies(
  titleIndex: readonly PageInfo[],
  changedSlugs: readonly string[],
  newSlugs: readonly string[],
): Map<string, FinalBody> {
  const changed = new Set(changedSlugs);
  const added = new Set(newSlugs);
  const newTitles = titleIndex.filter((page) => added.has(page.slug));
  const bodies = new Map<string, FinalBody>();
  for (const page of titleIndex) {
    const written = changed.has(page.slug);
    const outbound = written ? titleIndex : [];
    const inbound = newTitles.length > 0 && !added.has(page.slug) ? newTitles : [];
    if (outbound.length === 0 && inbound.length === 0) continue;
    const body = linkBody(page, outbound, inbound);
    if (!written && !differsFromDisk(page, body)) continue;
    bodies.set(page.slug, { page, body });
  }
  return bodies;
}

/**
 * Whether a page this run did not write now has a body worth writing anyway.
 *
 * Two ways that happens: a resolver pass inserted a link, or the curated-link overlay
 * restored one (`originalBody` is set exactly when the overlay changed the body). A page
 * the run touched for neither reason is left alone -- see {@link collectFinalBodies}.
 *
 * @param page - The page being composed.
 * @param body - The composed body.
 * @returns True when the composed body differs from the bytes the wiki holds.
 */
function differsFromDisk(page: PageInfo, body: string): boolean {
  return page.originalBody !== undefined || body !== page.body;
}

/**
 * Link one body: its own outbound titles first, then this run's new titles.
 *
 * Composed rather than one pass superseding the other. The passes used to race for
 * the same slug so that the inbound body REPLACED the outbound one, which meant a
 * changed page mentioning a page created by the same run was written without any
 * of the links the outbound pass had just added. Both passes only wrap a real
 * mention of a real title, so composing them keeps every mention, and the gate
 * below refuses anything the rules refuse.
 *
 * @param page - The page whose body is being linked.
 * @param outbound - Titles this page may link to (empty when it did not change).
 * @param inbound - Titles created by this run (empty on the outbound-only path).
 * @returns The body with both passes applied.
 */
function linkBody(
  page: PageInfo,
  outbound: readonly PageInfo[],
  inbound: readonly PageInfo[],
): string {
  const outboundBody = outbound.length === 0 ? page.body : addWikilinks(page.body, outbound, page.title);
  return inbound.length === 0
    ? outboundBody
    : addWikilinks(outboundBody, inbound, page.title);
}

/**
 * Judge every final body through the ONE link gate, and keep the writes that
 * actually change a page.
 *
 * @param root - Absolute project root the gate's reads are confined under.
 * @param titleIndex - Every page the resolver can see, for the fallback page set.
 * @param bodies - The bodies to judge, keyed by slug.
 * @param gate - What to judge against and where the counts go.
 * @returns One write per page the gate or the resolver changed.
 */
async function gateFinalBodies(
  root: string,
  titleIndex: readonly PageInfo[],
  bodies: ReadonlyMap<string, FinalBody>,
  gate: LinkGateOptions | undefined,
  rowBacked: boolean,
): Promise<CompilePageWrite[]> {
  if (bodies.size === 0) return [];
  const pages = await linkPageSetFor(root, titleIndex, gate?.pageContent, rowBacked);
  const writes: CompilePageWrite[] = [];
  for (const { page, body } of bodies.values()) {
    const validated = await validateContextualLinks(body, linkIndexFor(pages, anchorFor(page)));
    reportContextualLinkCounts(page.title, validated.counts);
    gate?.sink?.record(validated.counts);
    const write = rewritePage(page, validated.body);
    if (write) writes.push(write);
  }
  return writes;
}

/**
 * The page set the gate judges links against, taken from the run's own corpus.
 *
 * WHICH CORPUS. A content seam is the widest answer: every namespace, row by row.
 * Without one, the answer depends on where this run's pages actually live, and
 * getting that wrong is silent in one direction only: a corpus judged against the
 * wrong backend reports EVERY link as a missing target.
 *   - A file-backed run (no resolver source) has `wiki/` as its corpus, so `wiki/`
 *     is what the gate lists -- both namespaces, which is what generation used to
 *     resolve a `queries` target against and the only way such a link survives.
 *   - A row-backed run that named no seam can only be judged against the pages this
 *     phase already read, because the filesystem holds none of its corpus.
 * The resolver's own index supplies the unambiguous title lookups in every case, so
 * a title-shaped target is judged the same way whichever backend answered.
 *
 * @param root - Absolute project root the reads are confined under.
 * @param titleIndex - Every page the resolver can see.
 * @param pageContent - Row-backed reader, when the caller supplied one.
 * @param rowBacked - Whether this run's pages live in rows rather than in `wiki/`.
 * @returns The page set for this run's gate.
 */
async function linkPageSetFor(
  root: string,
  titleIndex: readonly PageInfo[],
  pageContent: PageContentSource | undefined,
  rowBacked: boolean,
): Promise<LinkPageSet> {
  const entries = knownEntriesOf(titleIndex);
  const base = pageContent === undefined && rowBacked
    ? knownLinkPageSet(entries)
    : { ...await listLinkPageSet(root, pageContent), titles: uniqueTitleMap(entries) };
  return { ...base, repair: await repairLookupFor(root, base) };
}

/**
 * The wiki's OWN repair rule, bound to this page set.
 *
 * `createRepairResolver` is the same function `link-repair` uses, so the gate accepts
 * exactly the abbreviations repair will canonicalise and refuses the ambiguous or
 * missing ones repair refuses. Reusing it is what keeps this from being a second name
 * matcher: the gate asks the owner of the rule.
 *
 * @param root - Absolute project root the pending-candidate read is confined under.
 * @param pages - The page set whose slugs the rule may land on.
 * @returns A written target to page id lookup, or undefined when there is nothing to
 *   match against.
 */
async function repairLookupFor(
  root: string,
  pages: LinkPageSet,
): Promise<((writtenTarget: string) => string | null) | undefined> {
  const bySlug = new Map(pages.ids.map((id) => [slugPartOf(id).toLowerCase(), id]));
  if (bySlug.size === 0) return undefined;
  const repair = createRepairResolver([...bySlug.keys()], await listLinkResolvablePendingSlugs(root));
  return (writtenTarget: string) => {
    const slug = repair(writtenTarget);
    return slug === null ? null : bySlug.get(slug) ?? null;
  };
}

/** The bare slug of a namespaced page id (`concepts/networks` to `networks`). */
function slugPartOf(id: string): string {
  const separator = id.lastIndexOf("/");
  return separator === -1 ? id : id.slice(separator + 1);
}

/**
 * The identities the resolver's index already holds, in the gate's shape.
 *
 * The title lookups come from here in BOTH modes, so a title-shaped link is judged
 * the same way whether the pages came from rows or from `wiki/`.
 *
 * @param titleIndex - Every page the resolver can see.
 * @returns One entry per page, with its declared aliases.
 */
function knownEntriesOf(titleIndex: readonly PageInfo[]): KnownPageIdentity[] {
  return titleIndex.map((page) => ({
    id: pageIdOf(page), title: page.title, aliases: page.aliases,
  }));
}

/** The gate's view of the page whose body is being judged. */
function anchorFor(page: PageInfo) {
  return { id: pageIdOf(page), title: page.title, aliases: page.aliases };
}

/** Namespaced page id of an index entry, e.g. `concepts/networks`. */
function pageIdOf(page: PageInfo): string {
  return `${namespaceForPath(page.filePath)}/${page.slug}`;
}

/**
 * COMPUTE interlink resolution and APPLY the rewrites in one step — the single
 * seam every resolution caller should use so the "{@link resolveLinks} returns
 * writes you MUST apply" contract can never be forgotten (its return value is no
 * longer discardable at the call site).
 *
 * PRECONDITION: the caller MUST already hold the project lock. This routes
 * through the LOCK-FREE {@link applyCompilePageWritesLocked}; every resolution
 * caller (compile's finalizeWiki, OKF refreshAfterImport, review approval) runs
 * under an already-held lock, so the self-locking path would self-deadlock.
 *
 * @param root - Absolute project root the writes are confined under.
 * @param changedSlugs - Slugs whose pages get outbound links re-resolved.
 * @param newSlugs - Newly-created slugs other pages get scanned for (inbound).
 * @param source - Row writer, or undefined to write files.
 * @param sink - Row writer, or undefined to write files.
 * @param remover - Row remover, or undefined to delete files.
 * @param transaction - Open batch the writes join, when the caller has one.
 * @param gate - What the final link gate judges against, and where its counts go.
 */
export async function resolveAndApplyLinks(
  root: string,
  changedSlugs: string[],
  newSlugs: string[],
  source?: ResolverPageSource,
  sink?: PageSink,
  remover?: PageRemover,
  transaction?: PageBatchTransaction,
  gate?: LinkGateOptions,
): Promise<void> {
  await applyCompilePageWritesLocked(
    root, await resolveLinks(root, changedSlugs, newSlugs, source, gate), pageStoreOptions(sink, remover, transaction),
  );
}

/** Derive the compile namespace from a page's absolute file path. */
function namespaceForPath(filePath: string): CompilePageNamespace {
  const dir = path.dirname(filePath);
  if (dir.endsWith(QUERIES_DIR) || path.basename(dir) === path.basename(QUERIES_DIR)) {
    return "queries";
  }
  return "concepts";
}

/**
 * Build the rewritten-page write for a PageInfo, or null when its body is unchanged.
 *
 * THE BASELINE IS THE PRE-OVERLAY BODY when the curated-link overlay changed this page.
 * `body` holds the restored text by then, and comparing against it would report "nothing
 * changed" for a link the overlay just put back.
 *
 * The replacement is a FUNCTION, not the string itself. `String.replace`
 * interprets `$&`, `` $` ``, `$'` and `$$` in a string replacement even when the
 * search argument is a plain string, and `linked` is page prose: a page reading
 * "the PID is $$" lost a `$`, and one containing a backtick-dollar had this
 * page's own frontmatter spliced into the middle of the sentence. Passing a
 * function suppresses that substitution entirely, so the rewritten body is
 * inserted verbatim.
 */
function rewritePage(page: PageInfo, linked: string): CompilePageWrite | null {
  const baseline = page.originalBody ?? page.body;
  if (linked === baseline) return null;
  return {
    namespace: namespaceForPath(page.filePath),
    slug: page.slug,
    body: page.content.replace(baseline, () => linked),
  };
}
