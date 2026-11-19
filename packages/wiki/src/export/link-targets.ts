/**
 * Page identity and wikilink-target resolution for the export writers.
 *
 * ## Why the export needs a resolver at all
 *
 * A page is `(page_directory, slug)` — `primary key (stack_id, page_directory, slug)`
 * (`packages/wiki/src/dimensions/wiki/schema.sql:106`), so `concepts/x` and
 * `queries/x` are two different pages and the string `x` names neither of them.
 * `ExportPage.links` holds NORMALIZED wikilink targets
 * (`packages/wiki/src/export/collect.ts:180` -> `normalizeWikilinkTarget`,
 * `packages/wiki/src/wiki/wikilink-tokens.ts:77`): a qualified `<namespace>/<slug>`
 * id keeps its namespace, and a bare target is just a slug. A writer that compares
 * those strings against bare slugs therefore matches nothing for a qualified link
 * and cannot tell two same-stem pages apart. Both defects are one bug: the value is
 * a page REFERENCE, not a page name, and resolving it needs the pair.
 *
 * ## Why this is not `resolveBareSlug`
 *
 * `packages/wiki/src/viewer/collect.ts:72` answers the same question for the viewer,
 * and its rule is duplicated here on purpose: `src/export/collect.ts` states that the
 * export path must not depend on the viewer, and a four-line lookup is cheaper to
 * keep aligned than a layer inversion is to undo. The rule itself is the wiki's own,
 * not a second opinion:
 *
 * - a QUALIFIED target resolves only inside its own namespace — an explicit
 *   namespace is never second-guessed;
 * - a BARE target keeps the concepts-then-queries precedence;
 * - inside a directory, an EXACT stem match wins over a slugified one, because a
 *   page's `slug` is its RAW filename stem (`wiki/collect.ts` keeps it verbatim) and
 *   a wikilink target is slugified, so both directions are compared. Without the
 *   two passes a title-shaped stem and a literal one would resolve by scan order.
 *
 * If that rule ever changes, `packages/wiki/src/export/qualified-link-targets.test.ts`
 * and the viewer's own suites have to change together.
 */

import { slugify } from "../utils/markdown.js";
import { parseQualifiedPageId } from "../utils/page-id.js";
import type { ExportPage, PageDirectory } from "./types.js";

/** The two DEFAULT wiki directories a link target can name. */
const LINK_NAMESPACES: readonly PageDirectory[] = ["concepts", "queries"];

/**
 * The qualified page id of an export page: `<pageDirectory>/<slug>`.
 *
 * This is the page's identity on every export surface — the GraphML node id and the
 * JSON-LD node `@id` — because it is the only form that distinguishes two pages
 * whose stems are equal. The bare `slug` stays available on the page itself for
 * display and for consumers that already know the directory.
 *
 * @param page - Any object carrying the two identity halves.
 * @returns The qualified page id, e.g. `concepts/retrieval`.
 */
export function exportPageId(page: Pick<ExportPage, "pageDirectory" | "slug">): string {
  return `${page.pageDirectory}/${page.slug}`;
}

/** The page set a link target is resolved against. */
export interface ExportLinkIndex {
  /** Every export page, in the order the collector sorted them. */
  readonly pages: readonly ExportPage[];
}

/**
 * Index the pages a writer is about to render.
 *
 * The pages themselves are kept rather than a `Map` keyed by id, because resolution
 * has to run in two passes per directory (exact stem, then slugified) and a keyed map
 * would only answer the exact half.
 *
 * @param pages - The export page list, as the collector produced it.
 * @returns The index to hand to {@link resolveExportLinkTarget}.
 */
export function buildExportLinkIndex(pages: readonly ExportPage[]): ExportLinkIndex {
  return { pages };
}

/**
 * Resolve one normalized wikilink target to the page it names.
 *
 * @param index - The page set being exported.
 * @param target - A normalized target: `<namespace>/<slug>` or a bare slug.
 * @returns The page, or `null` when nothing in the export answers to the target.
 */
export function resolveExportLinkTarget(
  index: ExportLinkIndex,
  target: string,
): ExportPage | null {
  const qualified = parseQualifiedPageId(target);
  if (qualified !== null) {
    const directory = LINK_NAMESPACES.find((namespace) => namespace === qualified.namespace);
    if (directory === undefined) return null;
    return findPageInDirectory(index.pages, directory, slugify(qualified.pagePart));
  }
  for (const directory of LINK_NAMESPACES) {
    const page = findPageInDirectory(index.pages, directory, target);
    if (page !== null) return page;
  }
  return null;
}

/**
 * The page in `directory` that `target` addresses, EXACT stem match first.
 *
 * A page's `slug` is its raw filename stem while a target is slugified, so a link to
 * `7-subdominios-ddd` may name either a page literally named that or a page titled
 * `7. Subdominios DDD`. The literal name wins, which makes the answer independent of
 * the order the collector happened to sort the pages in.
 *
 * @param pages - The export page list.
 * @param directory - The namespace to stay inside.
 * @param target - A bare slug.
 * @returns The matching page, or `null`.
 */
function findPageInDirectory(
  pages: readonly ExportPage[],
  directory: PageDirectory,
  target: string,
): ExportPage | null {
  if (target.length === 0) return null;
  const candidates = pages.filter((page) => page.pageDirectory === directory);
  return candidates.find((page) => page.slug === target)
    ?? candidates.find((page) => slugify(page.slug) === target)
    ?? null;
}

/**
 * Resolve a page's link targets to the pages they name, one entry per page.
 *
 * Deduplicated by resolved id: `[[y]]` and `[[concepts/y]]` in one body are one edge,
 * and emitting it twice would double a graph tool's edge count for a link the page
 * wrote once. First-occurrence order is preserved so the output stays deterministic.
 *
 * @param index - The page set being exported.
 * @param page - The page whose `links` are being rendered.
 * @returns The distinct pages this page links to, unresolvable targets dropped.
 */
export function resolveExportPageLinks(
  index: ExportLinkIndex,
  page: ExportPage,
): ExportPage[] {
  const seen = new Set<string>();
  const resolved: ExportPage[] = [];
  for (const target of page.links) {
    const linked = resolveExportLinkTarget(index, target);
    if (linked === null) continue;
    const id = exportPageId(linked);
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push(linked);
  }
  return resolved;
}
