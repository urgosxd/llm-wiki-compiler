/**
 * @file Validate the contextual links a generated page may keep.
 *
 * THE REQUIREMENT. "Los enlaces deben estar asociados a una mención o sección
 * real del artículo. No crees conexiones solo por similitud de embeddings ni
 * para aumentar artificialmente la conectividad. Valida el destino y evita
 * enlaces redundantes o autorreferencias innecesarias." A link with no anchor is
 * a defect, not a stylistic miss: it claims a relationship the article never
 * made, and because links are what `links-here` and the wiki-race traversal walk,
 * an unanchored link is a navigational lie that the graph then repeats forever.
 *
 * WHAT THIS MODULE IS. A deterministic pass over the FINAL BODY one page is
 * about to be written with, deciding KEEP or DEMOTE for every
 * `[[target|visible text]]` / `[[target]]` it contains. It runs no model, reads no
 * scores, and never invents text: a demoted link becomes the plain words of its
 * own visible text, so the sentence, the mention and the reader's paragraph all
 * survive and only the link markup is gone. The ANCHOR is the visible text — the
 * words the reader actually sees — and it must name the target concept by
 * canonical key, either the target page's title or one of its declared aliases.
 *
 * WHERE THE ONE GATE SITS, AND WHY THERE. Links reach a body through two channels:
 * the model types them inline, and `resolveLinks` wraps plain-text mentions of
 * page titles afterwards. The gate therefore runs in the LINK PHASE, once per
 * page, after the run's pages exist and after both channels have written into the
 * body it is handed — one decision table, one budget, one set of counters, and no
 * channel that can bypass them. Running it any earlier (at generation time) had
 * two defects: a page the SAME run is creating was not on disk yet, so every link
 * into it was demoted as `unresolved-target`, and everything `resolveLinks` added
 * afterwards was never judged at all. Because the pages are written first, the
 * planned page set IS the page set here: a target scheduled for writing in this
 * run resolves, and only a target that exists nowhere is reported missing.
 *
 * THE DECISION TABLE, first failing rule wins (and it is the reported reason):
 *   1. `unresolved-target` — the target is not a real page of this wiki, or its
 *      page cannot be read. Resolution goes through the ONE shared resolver
 *      ({@link resolveTargetNodeId}, scope `"article"`); this module owns no
 *      second name-matching chain.
 *   2. `self-reference` — the target is the page being written.
 *   3. `unanchored` — the visible text names something other than the target.
 *   4. `redundant` — this target was already linked earlier in the same section.
 *   5. `over-budget` — the page already keeps {@link MAX_CONTEXTUAL_LINKS_PER_PAGE}
 *      links.
 *
 * WHERE SIMILARITY IS FENCED OFF. Three channels could propose relatedness, and
 * none of them can become a link here:
 *   - Embedding similarity pairs (`extraction-identity.ts`) are an IDENTITY
 *     question, already demoted to a "possible duplicate" warning by the identity
 *     stage. This module does not import them and has no score input at all.
 *   - The `relatedPages` context the renderer pastes into the prompt is text in a
 *     PROMPT, never a source of body bytes: it is not a parameter of this module,
 *     and a page whose only relation to another is that context keeps zero links.
 *   - A model's own proposal only enters as an anchored mention in the body, and
 *     survives only by passing the table above.
 *
 * WHAT IT DOES NOT DO. It does not rewrite a kept link's target (that is
 * `link-repair`'s canonicalisation, which runs after this gate and creates no
 * link, so it cannot add one the table already refused), it never touches
 * frontmatter, and it leaves literal Markdown (fenced blocks, code spans) alone:
 * a `[[...]]` inside a code example is not a link to the reader, so demoting it
 * would corrupt the example.
 *
 * ANCHORING OF RESOLVER-CREATED LINKS. `resolveLinks` only links a real mention of
 * a real page title, so those links are anchored by construction and are kept by
 * the anchor rule; they are still held to the self-reference, redundancy,
 * unresolved-target and budget rules, which is the whole reason they pass here.
 */

import path from "path";
import { readdir } from "fs/promises";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { canonicalConceptKey } from "../dimensions/wiki/concept-identity.js";
import { resolveTargetNodeId } from "../context/resolve-target.js";
import { isLiteralMarkdown } from "./link-repair-code.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import {
  CONCEPTS_DIR,
  MAX_CONTEXTUAL_LINKS_PER_PAGE,
  QUERIES_DIR,
} from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import type { PageDirectory } from "../pages/list.js";
import type { GraphData, GraphNode, GraphNodeId } from "../viewer/types.js";

/** `[[target]]` and `[[target|visible text]]`, capturing everything inside. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** Separator between a wikilink's target and the text the reader sees. */
const ALIAS_SEPARATOR = "|";

/** An ATX heading at the start of a line: every heading opens a new section. */
const HEADING_PATTERN = /^#{1,6}[ \t]/gmu;

/** Directory separator used in a page id (`concepts/foo`). */
const ID_SEPARATOR = "/";

/** Why a link was demoted. Each reason is counted separately when reported. */
export type LinkDemotionReason =
  | "unresolved-target"
  | "self-reference"
  | "unanchored"
  | "redundant"
  | "over-budget";

/**
 * The reasons in the order the validator tests them, which is also the order
 * they are reported in: one fixed order, so the same page always produces the
 * same line.
 */
const DEMOTION_REASONS: readonly LinkDemotionReason[] = [
  "unresolved-target",
  "self-reference",
  "unanchored",
  "redundant",
  "over-budget",
];

/** How many links a body kept, and how many left each rule refused. */
export interface ContextualLinkCounts {
  kept: number;
  demoted: Record<LinkDemotionReason, number>;
}

/** The validated body plus what the compile reports about it. */
export interface ContextualLinkResult {
  /** The body to write: kept links intact, demoted ones reduced to their mention. */
  body: string;
  counts: ContextualLinkCounts;
}

/** What a link target must tell the validator about itself to be anchorable. */
export interface LinkTargetIdentity {
  /** Canonical display name, from the page's frontmatter title. */
  title: string;
  /** Every other name the page declares for itself. */
  aliases: readonly string[];
}

/** The page whose body is being validated. */
export interface LinkAnchorPage {
  /** Namespaced page id, e.g. `concepts/networks`. */
  id: string;
  /** Display title the compile is about to write. */
  title: string;
  /** Names the identity stage folded into this page. */
  aliases?: readonly string[];
}

/**
 * Everything one body's links are judged against.
 *
 * The page set is a real graph (see {@link buildPageLinkIndex}) so target
 * resolution is the shared resolver's answer, not a local one; identity is read
 * lazily because a body only names a handful of pages out of a whole wiki.
 */
export interface LinkAnchoringIndex {
  /** The page whose body is being validated, so self-links are recognised. */
  page: LinkAnchorPage;
  /** Every real page of this wiki, as graph nodes the shared resolver accepts. */
  graph: GraphData;
  /** Canonical title key to the one page declaring it, when the caller knows it. */
  titles?: ReadonlyMap<string, string>;
  /** The wiki's own repair rule, when the caller supplies it. */
  repair?: (writtenTarget: string) => string | null;
  /** The page cap this body is held to. */
  budget: number;
  /** Reads one target page's title and aliases, or null when it is unreadable. */
  identity: (id: string) => Promise<LinkTargetIdentity | null>;
}

/**
 * This wiki's page set, listed ONCE for every body one link phase gates.
 *
 * Listing it once is not an optimisation detail: a run gates every page it
 * writes, and one listing per page would re-read the whole page set per page --
 * and, worse, could answer differently for two pages of the same run. The
 * identity cache behind it is shared for the same reason, so a target's title is
 * read once and every body that links to it is judged against that one answer.
 */
export interface LinkPageSet {
  /** Every page id of this wiki, e.g. `concepts/networks`. */
  readonly ids: readonly string[];
  /** The set as a graph the ONE shared target resolver accepts. */
  readonly graph: GraphData;
  /** Reads one target's title and aliases, cached for the whole run. */
  readonly identity: (id: string) => Promise<LinkTargetIdentity | null>;
  /**
   * Canonical title key to the ONE page id that declares it.
   *
   * A link may name a page by its TITLE (`[[Beta Concept]]` against a page slugged
   * `beta`), which is exactly the form `link-repair` canonicalises afterwards. Such a
   * link names a real page, so the gate resolves it instead of reporting a missing
   * target; a title two pages both declare is left OUT, because a wrong target is
   * worse than a visibly unresolved one.
   */
  readonly titles?: ReadonlyMap<string, string>;
  /**
   * The wiki's OWN repair rule, for a written target too short or too inflected to
   * match a page exactly.
   *
   * Supplied by the link phase, which owns that chain (`createRepairResolver`); the
   * gate calls it and never re-implements it. Without it the gate would demote the
   * very links `link-repair` exists to canonicalise — `[[Argo CD]]` against a page
   * slugged `argo-cd-ownership` — and by the time repair ran the link would already
   * be plain text.
   */
  readonly repair?: (writtenTarget: string) => string | null;
}

/**
 * The unambiguous title lookups of a page set: canonical key to page id.
 *
 * @param entries - Every page the caller considers linkable.
 * @returns Keys declared by exactly one page, mapped to that page's id.
 */
export function uniqueTitleMap(
  entries: readonly KnownPageIdentity[],
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    const key = canonicalConceptKey(entry.title);
    if (key === "" || ambiguous.has(key)) continue;
    const seen = titles.get(key);
    if (seen !== undefined && seen !== entry.id) {
      titles.delete(key);
      ambiguous.add(key);
      continue;
    }
    titles.set(key, entry.id);
  }
  return titles;
}

/**
 * List this wiki's page set once, with a shared identity cache.
 *
 * @param root - Project root the wiki reads are confined under.
 * @param source - Row-backed page reader, or undefined to read `wiki/`.
 * @returns The page set and the cached identity reader built over it.
 */
export async function listLinkPageSet(
  root: string,
  source?: PageContentSource,
): Promise<LinkPageSet> {
  const ids = [
    ...await listPageIds(root, CONCEPTS_DIR, source),
    ...await listPageIds(root, QUERIES_DIR, source),
  ];
  const known = new Map<string, LinkTargetIdentity | null>();
  return {
    ids,
    graph: idGraph(ids),
    identity: async (id) => {
      if (!known.has(id)) known.set(id, await readTargetIdentity(root, id, source));
      return known.get(id) ?? null;
    },
  };
}

/**
 * Build the index ONE page's body is judged against, from a listed page set.
 *
 * The page being written is added even when it has no file yet: it is a real page
 * of this wiki by the end of the run, and a link back to it must be refused as a
 * self-reference rather than reported as a missing target. Its own identity is
 * answered from the caller's declaration and is deliberately NOT written into the
 * shared cache -- a self-reference is refused before identity is consulted, and
 * caching it would make every other body linking to this page be judged against
 * the caller's title instead of the wiki's.
 *
 * @param pages - This wiki's page set, listed once for the whole run.
 * @param page - The page whose body is being validated.
 * @returns The index this body's links are judged against.
 */
export function linkIndexFor(pages: LinkPageSet, page: LinkAnchorPage): LinkAnchoringIndex {
  const graph = pages.graph.nodes.some((node) => node.id === page.id)
    ? pages.graph
    : idGraph([...pages.ids, page.id]);
  return {
    page,
    graph,
    ...(pages.titles === undefined ? {} : { titles: pages.titles }),
    ...(pages.repair === undefined ? {} : { repair: pages.repair }),
    budget: MAX_CONTEXTUAL_LINKS_PER_PAGE,
    identity: async (id) => (id === page.id
      ? { title: page.title, aliases: page.aliases ?? [] }
      : pages.identity(id)),
  };
}

/**
 * Build the index one body is validated against, from the wiki as it is now.
 *
 * @param root - Project root the wiki reads are confined under.
 * @param page - The page whose body is being validated.
 * @param source - Row-backed page reader, or undefined to read `wiki/`.
 * @returns The index this body's links are judged against.
 */
export async function buildPageLinkIndex(
  root: string,
  page: LinkAnchorPage,
  source?: PageContentSource,
): Promise<LinkAnchoringIndex> {
  return linkIndexFor(await listLinkPageSet(root, source), page);
}

/** A page identity the caller already holds, so the gate reads nothing. */
export interface KnownPageIdentity extends LinkTargetIdentity {
  /** Namespaced page id, e.g. `concepts/networks`. */
  id: string;
}

/**
 * Build a page set from identities the caller already read.
 *
 * Used when the link phase has enumerated the pages itself: judging against that
 * enumeration costs no read and, more importantly, cannot disagree with the text the
 * links were resolved against. It is never a disk read, so a row-backed run does not
 * judge its links against a filesystem that holds nothing.
 *
 * @param entries - Every page the caller considers linkable.
 * @returns A page set answering from those entries only.
 */
export function knownLinkPageSet(entries: readonly KnownPageIdentity[]): LinkPageSet {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    ids: entries.map((entry) => entry.id),
    graph: idGraph(entries.map((entry) => entry.id)),
    identity: async (id) => byId.get(id) ?? null,
    titles: uniqueTitleMap(entries),
  };
}

/**
 * Every page id in one wiki namespace, as `<namespace>/<slug>`.
 *
 * @param root - Project root directory.
 * @param relDir - Project-relative wiki namespace (e.g. `wiki/concepts`).
 * @param source - Row-backed listing, or undefined to list the directory.
 * @returns Page ids in backend order.
 */
async function listPageIds(
  root: string,
  relDir: string,
  source: PageContentSource | undefined,
): Promise<string[]> {
  const namespace = path.posix.basename(relDir);
  if (source !== undefined) {
    const slugs = await source.listSlugs(namespace as PageDirectory);
    return slugs.map((slug) => `${namespace}${ID_SEPARATOR}${slug}`);
  }
  const files = await readdir(path.join(root, relDir)).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith(".md"))
    .map((file) => `${namespace}${ID_SEPARATOR}${file.slice(0, -".md".length)}`);
}

/**
 * A graph of ids only, the one thing {@link resolveTargetNodeId} reads.
 *
 * Title, kind and degree are placeholders: the shared resolver may only land on
 * a node's ID, so giving them real values would cost a read per page of the wiki
 * for information nothing consults.
 *
 * @param ids - Page ids, e.g. `concepts/networks`.
 * @returns Graph data with one node per id and no edges.
 */
function idGraph(ids: readonly string[]): GraphData {
  const nodes: GraphNode[] = ids.map((id) => {
    const separator = id.indexOf(ID_SEPARATOR);
    return {
      id: id as GraphNodeId,
      title: id,
      slug: id.slice(separator + 1),
      directory: id.slice(0, separator),
      kind: "page",
      degree: 0,
    };
  });
  return { nodes, edges: [] };
}

/**
 * Read what a target page says about itself.
 *
 * An empty read is `null`, not an empty identity: a page whose bytes are dropped
 * (an escaping symlink) or missing is not a target this pass may validate, and
 * treating it as one would let unreadable content decide a link.
 *
 * @param root - Project root the read is confined under.
 * @param id - Target page id, e.g. `concepts/networks`.
 * @param source - Row-backed page reader, or undefined to read `wiki/`.
 * @returns The page's title and aliases, or null when nothing can be read.
 */
async function readTargetIdentity(
  root: string,
  id: string,
  source: PageContentSource | undefined,
): Promise<LinkTargetIdentity | null> {
  const separator = id.indexOf(ID_SEPARATOR);
  const namespace = id.slice(0, separator);
  const relDir = [CONCEPTS_DIR, QUERIES_DIR].find((dir) => path.posix.basename(dir) === namespace);
  if (relDir === undefined) return null;
  const content = await readWikiPageFrom(root, relDir, id.slice(separator + 1), source);
  if (content === "") return null;
  const { meta } = parseFrontmatter(content);
  const title = typeof meta.title === "string" && meta.title.trim() !== ""
    ? meta.title
    : id.slice(separator + 1).replace(/-/gu, " ");
  return { title, aliases: stringList(meta.aliases) };
}

/** Reduce a frontmatter value to the plain strings it may contain. */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

/** One decided link: kept as written, or replaced by the words it mentions. */
type LinkDecision =
  | { readonly keep: true }
  | { readonly keep: false; readonly reason: LinkDemotionReason; readonly mention: string };

/** One `[[...]]` span to replace with its mention. */
interface Rewrite {
  start: number;
  end: number;
  text: string;
}

/** Bookkeeping threaded through one body's links. */
interface ValidationState {
  index: LinkAnchoringIndex;
  /** Heading offsets, ascending: the start of every section. */
  sections: readonly number[];
  counts: ContextualLinkCounts;
  /** Target ids already linked, per section index. */
  linked: Map<number, Set<string>>;
}

/**
 * Validate every contextual link in one generated body.
 *
 * @param body - The generated page body, frontmatter already stripped.
 * @param index - The page set, current page and budget to judge against.
 * @returns The body to write and the per-reason counts the compile reports.
 */
export async function validateContextualLinks(
  body: string,
  index: LinkAnchoringIndex,
): Promise<ContextualLinkResult> {
  const literal = isLiteralMarkdown(body);
  const state: ValidationState = {
    index,
    sections: sectionStarts(body, literal),
    counts: { kept: 0, demoted: emptyDemotions() },
    linked: new Map(),
  };
  const rewrites: Rewrite[] = [];
  for (const match of body.matchAll(WIKILINK_PATTERN)) {
    const offset = match.index;
    if (literal(offset)) continue;
    const decision = await decideLink(match[1] ?? "", offset, state);
    if (decision.keep) {
      state.counts.kept += 1;
      continue;
    }
    state.counts.demoted[decision.reason] += 1;
    rewrites.push({ start: offset, end: offset + match[0].length, text: decision.mention });
  }
  return { body: applyRewrites(body, rewrites), counts: state.counts };
}

/** Counts with nothing demoted yet. */
function emptyDemotions(): Record<LinkDemotionReason, number> {
  return {
    "unresolved-target": 0,
    "self-reference": 0,
    unanchored: 0,
    redundant: 0,
    "over-budget": 0,
  };
}

/**
 * Offsets at which a new section begins.
 *
 * A heading inside a fenced code block is sample text, not structure, so literal
 * offsets are filtered out; the redundancy rule then means "same section" the way
 * a reader sees it.
 *
 * @param body - The page body.
 * @param literal - Predicate for offsets inside literal Markdown.
 * @returns Ascending heading offsets.
 */
function sectionStarts(body: string, literal: (offset: number) => boolean): number[] {
  return [...body.matchAll(HEADING_PATTERN)]
    .map((match) => match.index)
    .filter((offset) => !literal(offset));
}

/** Which section a link at `offset` belongs to, as an index into the headings. */
function sectionOf(sections: readonly number[], offset: number): number {
  return sections.filter((start) => start <= offset).length;
}

/**
 * Apply the decision table to one link.
 *
 * @param rawInner - Everything inside the brackets, as written.
 * @param offset - Byte offset of the link in the body.
 * @param state - Section and budget bookkeeping for this body.
 * @returns Keep, or demote with the first failing reason and the surviving mention.
 */
async function decideLink(rawInner: string, offset: number, state: ValidationState): Promise<LinkDecision> {
  const { target, mention } = splitLink(rawInner);
  const targetId = resolveLinkTarget(state.index, target);
  if (targetId === null) return demote("unresolved-target", mention);
  if (targetId === state.index.page.id) return demote("self-reference", mention);
  const identity = await state.index.identity(targetId);
  if (identity === null) return demote("unresolved-target", mention);
  if (!isAnchored(state.index, target, mention, identity)) return demote("unanchored", mention);
  const section = sectionOf(state.sections, offset);
  const linked = state.linked.get(section) ?? new Set<string>();
  if (linked.has(targetId)) return demote("redundant", mention);
  if (state.counts.kept >= state.index.budget) return demote("over-budget", mention);
  linked.add(targetId);
  state.linked.set(section, linked);
  return { keep: true };
}

/**
 * Whether this link's visible text anchors the target it resolved to.
 *
 * Two ways, and the second exists because the wiki resolves links two ways. The
 * mention may NAME the target (its title or a declared alias) — the normal case. Or
 * the link was resolved by the wiki's own repair rule, which reads the written
 * target as an abbreviation of exactly one page: there the visible text IS the
 * written target, and `link-repair` keeps those words as the label of the page it
 * canonicalises, so a label that no longer matched would be a defect repair created.
 * A label that differs from both is still unanchored and still demoted.
 *
 * @param index - The page set being judged.
 * @param target - The target exactly as written.
 * @param mention - The words the reader sees.
 * @param identity - The resolved page's title and declared aliases.
 * @returns True when the mention anchors the link.
 */
function isAnchored(
  index: LinkAnchoringIndex,
  target: string,
  mention: string,
  identity: LinkTargetIdentity,
): boolean {
  if (namesTarget(mention, identity)) return true;
  return index.repair !== undefined && mention === target;
}

/** A refused link: the mention is what stays on the page. */
function demote(reason: LinkDemotionReason, mention: string): LinkDecision {
  return { keep: false, reason, mention };
}

/**
 * Split `target|visible text` into the target and the words the reader sees.
 *
 * The visible text defaults to the target, so `[[graph-theory]]` is anchored only
 * if its own slug names the concept, and demoting it leaves that slug as text.
 *
 * @param rawInner - Everything between the brackets.
 * @returns The target to resolve and the mention to keep on demotion.
 */
function splitLink(rawInner: string): { target: string; mention: string } {
  const separator = rawInner.indexOf(ALIAS_SEPARATOR);
  if (separator === -1) {
    const target = rawInner.trim();
    return { target, mention: target };
  }
  const target = rawInner.slice(0, separator).trim();
  const visible = rawInner.slice(separator + 1).trim();
  return { target, mention: visible === "" ? target : visible };
}

/**
 * Resolve a written target through the ONE shared resolver, then by title, then by
 * the wiki's repair rule.
 *
 * A model writing from the prompt sees page TITLES, so a bare title is offered
 * as the slug it would have as well as verbatim; a namespaced target
 * (`concepts/foo`) is offered as written. A title that no slug matches is resolved
 * through {@link LinkPageSet.titles}, and an abbreviation through
 * {@link LinkPageSet.repair}; both are identities this wiki already uses elsewhere,
 * so recognising them here is not a second chain — refusing them would destroy links
 * generation meant to make and repair meant to fix. Nothing else is tried: inventing
 * a prefix or case-folding search here would be the second chain this pass exists to
 * avoid.
 *
 * @param index - The page set and budget this body is judged against.
 * @param target - The target text as written in the link.
 * @returns The resolved page id, or null when no real page answers to it.
 */
function resolveLinkTarget(index: LinkAnchoringIndex, target: string): string | null {
  const candidates = target.includes(ID_SEPARATOR) ? [target] : [slugify(target), target];
  for (const candidate of candidates) {
    const resolved = resolveTargetNodeId(index.graph, candidate, "article");
    if (resolved !== null) return resolved;
  }
  const byTitle = index.titles?.get(canonicalConceptKey(target));
  if (byTitle !== undefined) {
    const resolved = resolveTargetNodeId(index.graph, byTitle, "article");
    if (resolved !== null) return resolved;
  }
  return index.repair?.(target) ?? null;
}

/**
 * Whether the visible text actually names the target concept.
 *
 * Compared by canonical key, the same identity rule the merge tiers use, so
 * "Vector DB" anchors a page titled "Vector Database" that declares it, and a
 * mention of something else does not anchor a link to it at all.
 *
 * @param mention - The words the reader sees.
 * @param identity - The target page's title and declared aliases.
 * @returns True when the mention names the target.
 */
function namesTarget(mention: string, identity: LinkTargetIdentity): boolean {
  const anchorKey = canonicalConceptKey(mention);
  if (anchorKey === "") return false;
  return [identity.title, ...identity.aliases]
    .some((name) => canonicalConceptKey(name) === anchorKey);
}

/**
 * Replace each demoted link with its mention, back to front so earlier offsets
 * stay valid.
 *
 * @param body - The body as generated.
 * @param rewrites - Demotions in ascending offset order.
 * @returns The body with link markup removed and mentions kept.
 */
function applyRewrites(body: string, rewrites: readonly Rewrite[]): string {
  let result = body;
  for (const rewrite of [...rewrites].reverse()) {
    result = result.slice(0, rewrite.start) + rewrite.text + result.slice(rewrite.end);
  }
  return result;
}

/** Counts with nothing demoted yet, the shape a run's total starts from. */
export function emptyContextualLinkCounts(): ContextualLinkCounts {
  return { kept: 0, demoted: emptyDemotions() };
}

/**
 * Fold one page's counts into a run's total.
 *
 * ONE definition of what a run total is: the same reasons, in the same order, so
 * the run line can never disagree with the per-page lines it summarizes.
 *
 * @param total - The run's running total, mutated in place.
 * @param counts - One page's counts, as {@link validateContextualLinks} returned them.
 */
export function addContextualLinkCounts(total: ContextualLinkCounts, counts: ContextualLinkCounts): void {
  total.kept += counts.kept;
  for (const reason of DEMOTION_REASONS) total.demoted[reason] += counts.demoted[reason];
}

/**
 * One line describing what a page or a run kept and refused, or null when no rule
 * refused anything.
 *
 * Shared by the per-page report and the run aggregate so both read the same way:
 * the reasons are listed in the order the table tests them, and a reason that
 * refused nothing is left out rather than printed as a zero.
 *
 * @param counts - Counts for one page, or a run total.
 * @returns The summary text, or null when nothing was demoted.
 */
export function describeLinkCounts(counts: ContextualLinkCounts): string | null {
  const refused = DEMOTION_REASONS.filter((reason) => counts.demoted[reason] > 0);
  if (refused.length === 0) return null;
  const total = refused.reduce((sum, reason) => sum + counts.demoted[reason], 0);
  const breakdown = refused.map((reason) => `${counts.demoted[reason]} ${reason}`).join(", ");
  return `${counts.kept} kept, ${total} demoted (${breakdown})`;
}

/**
 * Print what this page's link validation decided: kept links, and how many each
 * rule refused.
 *
 * Emitted only when something was demoted. Silence means "every link this page
 * carries is anchored, unique and in budget", which is the normal case; a
 * truncation or a refusal is a limit the reader has to be able to see (no silent
 * limits), and the per-reason breakdown is what makes it actionable.
 *
 * @param pageTitle - The concept this body was written for.
 * @param counts - The counts returned by {@link validateContextualLinks}.
 */
export function reportContextualLinkCounts(pageTitle: string, counts: ContextualLinkCounts): void {
  const summary = describeLinkCounts(counts);
  if (summary === null) return;
  output.status(
    "!",
    output.warn(`Contextual links in "${pageTitle}": ${summary}.`),
  );
}
