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
 * WHAT THIS MODULE IS. A deterministic pass over the BODY the model returned,
 * deciding KEEP or DEMOTE for every `[[target|visible text]]` / `[[target]]` it
 * contains. It runs no model, reads no scores, and never invents text: a demoted
 * link becomes the plain words of its own visible text, so the sentence, the
 * mention and the reader's paragraph all survive and only the link markup is
 * gone. The ANCHOR is the visible text — the words the reader actually sees —
 * and it must name the target concept by canonical key, either the target page's
 * title or one of its declared aliases.
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
 * `link-repair`'s canonicalisation), it never touches frontmatter, and it leaves
 * literal Markdown (fenced blocks, code spans) alone: a `[[...]]` inside a code
 * example is not a link to the reader, so demoting it would corrupt the example.
 * One consequence worth stating: a link to a page created in the SAME run is not
 * on disk yet, so it is demoted as unresolved at generation time. Title-shaped
 * mentions recover afterwards through the rule-based interlink resolver, which
 * links plain-text mentions of real page titles once every page exists.
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
  /** The page cap this body is held to. */
  budget: number;
  /** Reads one target page's title and aliases, or null when it is unreadable. */
  identity: (id: string) => Promise<LinkTargetIdentity | null>;
}

/**
 * Build the index one generated body is validated against.
 *
 * The page being written is added even when it has no file yet: it is a real
 * page of this wiki by the end of the run, and a link back to it must be refused
 * as a self-reference rather than reported as a missing target.
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
  const ids = [...await listPageIds(root, CONCEPTS_DIR, source), ...await listPageIds(root, QUERIES_DIR, source)];
  if (!ids.includes(page.id)) ids.push(page.id);
  const known = new Map<string, LinkTargetIdentity | null>([
    [page.id, { title: page.title, aliases: page.aliases ?? [] }],
  ]);
  return {
    page,
    graph: idGraph(ids),
    budget: MAX_CONTEXTUAL_LINKS_PER_PAGE,
    identity: async (id) => {
      if (!known.has(id)) known.set(id, await readTargetIdentity(root, id, source));
      return known.get(id) ?? null;
    },
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
  const targetId = resolveLinkTarget(state.index.graph, target);
  if (targetId === null) return demote("unresolved-target", mention);
  if (targetId === state.index.page.id) return demote("self-reference", mention);
  const identity = await state.index.identity(targetId);
  if (identity === null) return demote("unresolved-target", mention);
  if (!namesTarget(mention, identity)) return demote("unanchored", mention);
  const section = sectionOf(state.sections, offset);
  const linked = state.linked.get(section) ?? new Set<string>();
  if (linked.has(targetId)) return demote("redundant", mention);
  if (state.counts.kept >= state.index.budget) return demote("over-budget", mention);
  linked.add(targetId);
  state.linked.set(section, linked);
  return { keep: true };
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
 * Resolve a written target through the ONE shared resolver.
 *
 * A model writing from the prompt sees page TITLES, so a bare title is offered
 * as the slug it would have as well as verbatim; a namespaced target
 * (`concepts/foo`) is offered as written. Nothing else is tried: inventing a
 * prefix or case-folding search here would be the second resolution chain this
 * pass exists to avoid.
 *
 * @param graph - Every real page of this wiki.
 * @param target - The target text as written in the link.
 * @returns The resolved page id, or null when no real page answers to it.
 */
function resolveLinkTarget(graph: GraphData, target: string): string | null {
  const candidates = target.includes(ID_SEPARATOR) ? [target] : [slugify(target), target];
  for (const candidate of candidates) {
    const resolved = resolveTargetNodeId(graph, candidate, "article");
    if (resolved !== null) return resolved;
  }
  return null;
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

/**
 * Print what this page's link validation decided: kept links, and how many each
 * rule refused.
 *
 * Emitted only when something was demoted. Silence means "every link the model
 * wrote was anchored", which is the normal case; a truncation or a refusal is a
 * limit the reader has to be able to see (no silent limits), and the per-reason
 * breakdown is what makes it actionable.
 *
 * @param pageTitle - The concept this body was written for.
 * @param counts - The counts returned by {@link validateContextualLinks}.
 */
export function reportContextualLinkCounts(pageTitle: string, counts: ContextualLinkCounts): void {
  const refused = DEMOTION_REASONS.filter((reason) => counts.demoted[reason] > 0);
  if (refused.length === 0) return;
  const total = refused.reduce((sum, reason) => sum + counts.demoted[reason], 0);
  const breakdown = refused.map((reason) => `${counts.demoted[reason]} ${reason}`).join(", ");
  output.status(
    "!",
    output.warn(`Contextual links in "${pageTitle}": ${counts.kept} kept, ${total} demoted (${breakdown}).`),
  );
}
