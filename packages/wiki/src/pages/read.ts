/**
 * Page-reading utilities for llmwiki.
 *
 * Exposes `readPageRecord`, which locates a wiki page by slug across the
 * priority-ordered page directories (concepts first, then queries), parses
 * its frontmatter, and returns a structured `PageRecord`. Orphaned pages are
 * silently skipped to match the query pipeline's behaviour.
 *
 * The lookup argument is either a bare slug (searched concepts-then-queries) or a
 * qualified page id `<namespace>/<page-part>` (searched inside that namespace only).
 * A page is `(page_directory, slug)`, so the qualified form is the only one that can
 * name a page unambiguously when both directories hold the same stem.
 *
 * This module is shared between the MCP tool layer and the in-process SDK so
 * both consumers work from identical read semantics.
 */

import { readdir } from "fs/promises";
import path from "path";
import { safeReadFile, parseFrontmatter, slugify } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { extractWikilinkTargets } from "../wiki/collect.js";
import { parseQualifiedPageId } from "../utils/page-id.js";

/** File extension a wiki page carries. */
const MD_SUFFIX = ".md";

/** Directories searched (in priority order) when resolving a page slug. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

/**
 * One OUTGOING wikilink from a page, in the form a caller can follow.
 *
 * `slug` is the target page's NORMALIZED id — the same value `Page.links` carries and
 * the value `read_page` accepts — so a client can hand it back verbatim instead of
 * re-deriving it from the anchor text. `label` is the text the page actually wrote,
 * which is NOT the id: an aliased link `[[beta|Beta label]]` reports
 * `{ slug: "beta", label: "Beta label" }`.
 *
 * The source is the page BODY: wikilinks are the edges the compiled page itself
 * carries. Incoming links are a different feature and are not reported here.
 */
export interface PageLinkRef {
  /**
   * Target page id, directly usable as `read_page`'s `slug` argument.
   *
   * Slugified from the wikilink target, so it matches the on-disk filename rather
   * than the human-typed link text, and QUALIFIED (`concepts/beta`) when the body
   * named the namespace. The namespace is carried rather than projected away because
   * a page is `(page_directory, slug)` — `primary key (stack_id, page_directory, slug)`
   * in `packages/wiki/src/dimensions/wiki/schema.sql:106` — so `beta` and
   * `concepts/beta` name different sets of pages as soon as both directories hold the
   * stem, and a projected value would silently follow the link to the wrong one.
   *
   * It is not validated against the corpus: a wikilink to a page that was never
   * written yields an id that `read_page` reports as not found, which is the same
   * answer the body itself gives.
   */
  slug: string;
  /**
   * Anchor text the page used for this link, falling back to the target text when
   * the wikilink carries no alias.
   */
  label: string;
}

/**
 * Every outgoing wikilink target in `body`, as followable refs.
 *
 * Built on the same extractor the page model uses (`extractWikilinkTargets`), so
 * the refs describe the same edges as `Page.links` rather than a second, looser
 * reading of the markdown. One ref per distinct target, in first-appearance order;
 * a repeated link reports the alias it was first written with.
 *
 * @param body - Page markdown body, frontmatter already stripped.
 * @returns Outgoing link refs; empty when the body has no wikilinks.
 */
export function pageLinkRefs(body: string): PageLinkRef[] {
  return extractWikilinkTargets(body).map((target) => ({
    // The normalized target, carried as written: it is a page id, and `read_page`
    // accepts both forms, so nothing has to be discarded to make it followable.
    slug: target.slug,
    label: target.display,
  }));
}

/** Shape returned by readPageRecord and search_pages for each matching page. */
export interface PageRecord {
  slug: string;
  title: string;
  summary: string;
  body: string;
  /**
   * Outgoing wikilinks carried by `body`, when the producer resolved them.
   *
   * OPTIONAL on purpose: `readPageRecord` always fills it, but other producers of
   * this shape (the row registry's `parsePageRecord`, embeddings loaders) build a
   * record from columns that carry no body-parsed edges, and a required field would
   * force every one of them to synthesise an empty array it cannot justify.
   */
  links?: readonly PageLinkRef[];
}

/**
 * Read one page from one directory, reporting it under `reportedSlug`.
 *
 * `pageSlug` is the STEM on disk; `reportedSlug` is the argument the caller used, so a
 * qualified read answers with the id it was given and a bare read with the slug it was
 * given. Orphaned pages resolve to `null`, the behaviour every caller shares.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param directory - Directory of the page, e.g. `wiki/concepts`.
 * @param pageSlug - Filename stem on disk.
 * @param reportedSlug - Value to report as `PageRecord.slug`.
 * @returns The record, or `null` when the file is unreadable or orphaned.
 */
async function readPageAt(
  root: string,
  directory: string,
  pageSlug: string,
  reportedSlug: string,
): Promise<PageRecord | null> {
  const content = await safeReadFile(path.join(root, directory, `${pageSlug}.md`));
  if (!content) return null;

  const { meta, body } = parseFrontmatter(content);
  if (meta.orphaned) return null;

  const trimmedBody = body.trim();
  return {
    slug: reportedSlug,
    title: typeof meta.title === "string" ? meta.title : pageSlug,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    body: trimmedBody,
    links: pageLinkRefs(trimmedBody),
  };
}

/**
 * Filename stems of the readable pages in one directory, sorted.
 *
 * Sorted because `readdir` order is not promised, and the two-pass match below must
 * not depend on it when two stems slugify to the same target. An absent or unreadable
 * directory holds no pages — a project without `wiki/queries/` is supported, and
 * throwing there would turn "no page here" into a failure.
 *
 * @param directoryPath - Absolute path to the directory.
 * @returns Page stems, without the `.md` extension.
 */
async function pageStemsIn(directoryPath: string): Promise<string[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(MD_SUFFIX))
      .map((entry) => entry.name.slice(0, -MD_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find the stem in ONE directory that a normalized page part addresses.
 *
 * TWO PASSES, and the order is the rule: a page's `slug` is its RAW filename stem,
 * while a wikilink target is slugified (`normalizeWikilinkTarget`, the one
 * normalization rule), so a link to a page titled `7. Subdominios DDD` reaches this
 * lookup as `7-subdominios-ddd` and both directions have to be compared. An exact
 * stem match therefore wins — the id names that page literally — and only then is the
 * slugified form tried.
 *
 * This MIRRORS `findPageInDirectory` in `packages/wiki/src/viewer/collect.ts:129`
 * deliberately rather than calling it: that helper matches against an in-memory page
 * list and is not exported, so reusing it would mean scanning BOTH directories and
 * building the whole viewer index to answer one `read_page` call, and importing the
 * viewer into the shared read layer would invert a dependency the export path already
 * keeps out. The two copies are three lines each and the shared rule is named in both.
 *
 * @param directoryPath - Absolute path to the ONE directory to search.
 * @param target - Normalized page part, e.g. `7-subdominios-ddd`.
 * @returns The matching stem, or `null` when nothing in this directory answers to it.
 */
async function findStemInDirectory(
  directoryPath: string,
  target: string,
): Promise<string | null> {
  const stems = await pageStemsIn(directoryPath);
  return stems.find((stem) => stem === target)
    ?? stems.find((stem) => slugify(stem) === target)
    ?? null;
}

/**
 * Locate a page by slug across the priority-ordered page directories,
 * skipping orphaned entries to match the query pipeline's behaviour.
 *
 * A BARE slug keeps the direct filename lookup it has always done: concepts, then
 * queries, exact stem, no scan — its cost and its answers are unchanged.
 *
 * A QUALIFIED id searches ONLY the namespace it names (an explicit namespace is never
 * second-guessed, and a namespace that is not a wiki directory names nothing), and
 * inside it applies the shared two-pass rule through {@link findStemInDirectory}: an
 * id the extractor produced resolves even when the page's stem is title-shaped.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param slug - Page slug without the `.md` extension, or a qualified page id
 *   (`concepts/retrieval`) — the two forms `read_page` documents.
 * @returns The parsed page record, or `null` if not found or orphaned.
 */
export async function readPageRecord(root: string, slug: string): Promise<PageRecord | null> {
  const qualified = parseQualifiedPageId(slug);
  if (qualified === null) {
    for (const directory of PAGE_DIRS) {
      const record = await readPageAt(root, directory, slug, slug);
      if (record !== null) return record;
    }
    return null;
  }
  const directory = PAGE_DIRS.find((dir) => path.basename(dir) === qualified.namespace);
  if (directory === undefined) return null;
  const stem = await findStemInDirectory(path.join(root, directory), qualified.pagePart);
  return stem === null ? null : readPageAt(root, directory, stem, slug);
}
