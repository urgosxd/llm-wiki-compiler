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

import path from "path";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { extractWikilinkTargets } from "../wiki/collect.js";
import { parseQualifiedPageId } from "../utils/page-id.js";

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
 * The `(directory, page-slug)` pairs one lookup argument addresses, in search order.
 *
 * A BARE slug searches the documented concepts-then-queries order. A QUALIFIED id
 * (`<namespace>/<page-part>`, the form `links[].slug` carries) addresses exactly one
 * directory: an explicit namespace is never second-guessed, and a namespace that is
 * not one of the wiki's directories addresses nothing at all — which is why it yields
 * an empty list rather than falling back to the bare order.
 *
 * The page part is used VERBATIM, like the bare slug: this lookup has never slugified
 * or scanned, so a page whose filename stem is title-shaped is addressed by that stem
 * in the qualified form too.
 *
 * @param slug - The lookup argument, bare or qualified.
 * @returns The pairs to try, in order.
 */
function lookupTargets(slug: string): Array<{ directory: string; pageSlug: string }> {
  const qualified = parseQualifiedPageId(slug);
  if (qualified === null) {
    return PAGE_DIRS.map((directory) => ({ directory, pageSlug: slug }));
  }
  const directory = PAGE_DIRS.find((dir) => path.basename(dir) === qualified.namespace);
  return directory === undefined ? [] : [{ directory, pageSlug: qualified.pagePart }];
}

/**
 * Locate a page by slug across the priority-ordered page directories,
 * skipping orphaned entries to match the query pipeline's behaviour.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param slug - Page slug without the `.md` extension, or a qualified page id
 *   (`concepts/retrieval`) — the two forms `read_page` documents.
 * @returns The parsed page record, or `null` if not found or orphaned.
 */
export async function readPageRecord(root: string, slug: string): Promise<PageRecord | null> {
  for (const { directory, pageSlug } of lookupTargets(slug)) {
    const content = await safeReadFile(path.join(root, directory, `${pageSlug}.md`));
    if (!content) continue;

    const { meta, body } = parseFrontmatter(content);
    if (meta.orphaned) continue;

    const trimmedBody = body.trim();
    return {
      // The argument as the caller wrote it, so a qualified read reports the id it was
      // given and a bare read reports the slug it was given.
      slug,
      title: typeof meta.title === "string" ? meta.title : pageSlug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
      body: trimmedBody,
      links: pageLinkRefs(trimmedBody),
    };
  }
  return null;
}
