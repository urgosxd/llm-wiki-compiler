/**
 * @file src/dimensions/wiki/page-answer.ts
 * @description The wiki's page-answering logic, expressed once over a list of
 * pages, so the filesystem reader and the database reader cannot disagree.
 *
 * ## Why this file exists
 *
 * W3.3 adds a database-backed reader while W3.4 requires the filesystem one to
 * stay selectable. Two readers that each scatter their own mapping, their own
 * kind filtering and their own name-resolution tiers WILL drift — and the drift
 * would be invisible, because each would keep passing its own tests while
 * answering differently. That is the failure mode a "selectable implementation"
 * is supposed to make impossible.
 *
 * So the two readers are reduced to what genuinely differs: how they OBTAIN a list
 * of pages. Everything after that — mapping to the neutral entity shape, filtering
 * by kind, choosing between an exact and a substring title match — lives here once.
 *
 * ## What is deliberately shared even though it looks small
 *
 * `toReadEntity` is four lines and could be copied safely today. It is here anyway:
 * the equivalence between backends is the contract, and a four-line copy is exactly
 * the kind of thing that gets one field edited in one place. The same reasoning
 * applies to the exact-then-substring tiering, whose ORDER is semantic (a
 * convenience match must not outrank an unambiguous one).
 */

import type { Page } from "../../pages/list.js";
import type { DimensionAnswer, ReadEntity } from "../read-types.js";

/** Default cap when the caller does not set one. */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Map a compiled page onto the dimension-neutral entity shape.
 *
 * The page's directory IS its kind: the wiki has no other taxonomy.
 *
 * @param page - One page, from either backend.
 * @returns The dimension-neutral entity.
 */
function toReadEntity(page: Page): ReadEntity {
  return {
    id: page.slug,
    name: page.title,
    kind: page.pageDirectory,
    description: page.summary,
  };
}

/**
 * Restrict pages to the requested directories.
 *
 * No kinds requested means no restriction, not "nothing matches" — the distinction
 * matters because an empty array from a caller that did not filter should not
 * silently hide the whole wiki.
 *
 * @param pages - Pages to filter.
 * @param kinds - Requested directories, or undefined/empty for all.
 * @returns The pages whose directory was requested.
 */
export function scopeByKinds(
  pages: readonly Page[],
  kinds: readonly string[] | undefined,
): readonly Page[] {
  if (kinds === undefined || kinds.length === 0) return pages;
  return pages.filter((page) => kinds.includes(page.pageDirectory));
}

/**
 * Pages whose title or summary mentions the text, case-insensitively.
 *
 * A LITERAL containment test, not a fuzzy match: the semantic path is a separate
 * capability, and blending the two would make it impossible to tell which signal
 * produced a result.
 *
 * @param pages - Pages to search.
 * @param text - Needle, any case.
 * @returns Pages that mention the text.
 */
function matchingPages(pages: readonly Page[], text: string): Page[] {
  const needle = text.toLowerCase();
  return pages.filter(
    (page) =>
      page.title.toLowerCase().includes(needle) ||
      page.summary.toLowerCase().includes(needle),
  );
}

/**
 * The single best page for a requested name: exact title first, then substring.
 *
 * The tier ORDER is semantic. An exact title is unambiguous, while a substring is a
 * convenience that can match several pages, so it is only consulted when the exact
 * tier found nothing. Reversing it would let "DB" win over a page literally titled
 * "DB".
 *
 * @param pages - Candidate pages.
 * @param name - The requested title.
 * @returns The chosen page, or `undefined` when nothing matches.
 */
export function resolvePageByName(
  pages: readonly Page[],
  name: string,
): Page | undefined {
  const needle = name.toLowerCase();
  const exact = pages.filter((page) => page.title.toLowerCase() === needle);
  const found = exact.length > 0 ? exact : matchingPages(pages, needle);
  return found[0];
}

/**
 * An answer built from a list of pages: entities only.
 *
 * `relationships` is always empty and `chunks` always empty here, for the same
 * reason both readers document: the wiki renders interlinks as `[[wikilinks]]`
 * inside a body, so a link is not a typed edge with a confidence, and inventing an
 * edge kind the store cannot back would make cross-dimension ranking meaningless.
 *
 * @param pages - Pages to report as entities.
 * @returns The answer.
 */
export function answerFromPages(pages: readonly Page[]): DimensionAnswer {
  return { entities: pages.map(toReadEntity), relationships: [], chunks: [] };
}
