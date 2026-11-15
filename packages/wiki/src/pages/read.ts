/**
 * Page-reading utilities for llmwiki.
 *
 * Exposes `readPageRecord`, which locates a wiki page by slug across the
 * priority-ordered page directories (concepts first, then queries), parses
 * its frontmatter, and returns a structured `PageRecord`. Orphaned pages are
 * silently skipped to match the query pipeline's behaviour.
 *
 * This module is shared between the MCP tool layer and the in-process SDK so
 * both consumers work from identical read semantics.
 */

import path from "path";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { extractWikilinkTargets } from "../wiki/collect.js";

/** Directories searched (in priority order) when resolving a page slug. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

/**
 * One OUTGOING wikilink from a page, in the form a caller can follow.
 *
 * `slug` is the target page's slug — the value `read_page` accepts, so a client
 * can hand it back verbatim instead of re-deriving it from the anchor text.
 * `label` is the text the page actually wrote, which is NOT the slug: an aliased
 * link `[[beta|Beta label]]` reports `{ slug: "beta", label: "Beta label" }`.
 *
 * The source is the page BODY: wikilinks are the edges the compiled page itself
 * carries. Incoming links are a different feature and are not reported here.
 */
export interface PageLinkRef {
  /**
   * Target page slug, directly usable as `read_page`'s `slug` argument.
   *
   * Slugified from the wikilink target, so it matches the on-disk filename rather
   * than the human-typed link text. It is not validated against the corpus: a
   * wikilink to a page that was never written yields a slug that `read_page`
   * reports as not found, which is the same answer the body itself gives.
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
 * Locate a page by slug across the priority-ordered page directories,
 * skipping orphaned entries to match the query pipeline's behaviour.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param slug - Page slug without the `.md` extension.
 * @returns The parsed page record, or `null` if not found or orphaned.
 */
export async function readPageRecord(root: string, slug: string): Promise<PageRecord | null> {
  for (const dir of PAGE_DIRS) {
    const content = await safeReadFile(path.join(root, dir, `${slug}.md`));
    if (!content) continue;

    const { meta, body } = parseFrontmatter(content);
    if (meta.orphaned) continue;

    const trimmedBody = body.trim();
    return {
      slug,
      title: typeof meta.title === "string" ? meta.title : slug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
      body: trimmedBody,
      links: pageLinkRefs(trimmedBody),
    };
  }
  return null;
}
