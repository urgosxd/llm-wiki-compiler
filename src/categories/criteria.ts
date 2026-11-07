/**
 * @file The CHECKABLE half of a category's inclusion criterion (S10).
 *
 * ## Why a criterion has to be checkable
 *
 * S10 requires every category to state an inclusion criterion. Prose alone is not a
 * criterion: "pages about distributed systems" decides nothing, because no two
 * readers agree on which pages those are and no code can tell. So the contract this
 * module enforces is narrower and testable — an inclusion criterion must QUOTE, in
 * double quotes, the words a page has to mention to belong:
 *
 *     Páginas que mencionen "consenso distribuido" o "replicación".
 *
 * The quoted terms are the criterion's executable form. The stage extracts them,
 * tests the article's own rendered text against each one, and records WHICH term
 * matched as the member's `evidenceKey`. Three consequences follow, all of them the
 * point:
 *
 *  1. A category is never created from an article that does not satisfy its own
 *     criterion — the proposal is refused and counted, not trusted.
 *  2. A reader can re-run the same test months later: the stored criterion still
 *     quotes the words, and the member entry still names the one that justified it.
 *  3. The evidence is derived from the ARTICLE's content, never from an identifier
 *     list, which is what `S10`'s "criterio de inclusión" asks for in practice.
 *
 * ## The term test reuses the plain-mention rule
 *
 * {@link firstPlainMention} is the same predicate the reference review uses to decide
 * that a page really names an article: a word-bounded, case-insensitive match that is
 * not inside an existing link, a citation marker or a literal code span. Reusing it
 * means "the article mentions this term" means one thing in this codebase instead of
 * two slightly different things. It is the retrieval primitive, not a similarity
 * score: nothing numeric decides membership (see `S14`).
 */

import { slugify } from "../utils/markdown.js";
import { firstPlainMention } from "../compiler/link-review-candidates.js";
import { criterionKeyFor } from "./members.js";

/**
 * A quoted span inside a criterion: straight double quotes, typographic quotes or a
 * backtick span, which are the three forms a model actually writes.
 */
const QUOTED_TERM = /"([^"]+)"|\u201c([^\u201d]+)\u201d|`([^`]+)`/gu;

/**
 * The checkable terms an inclusion criterion quotes.
 *
 * A term with no letter or digit is dropped rather than kept: it cannot be turned into
 * an evidence key, so it could never be audited, and a criterion made only of such
 * terms is refused as uncheckable by the caller.
 *
 * @param criterion - The criterion prose.
 * @returns The quoted terms, trimmed, deduplicated by spelling, in criterion order.
 */
export function criterionTerms(criterion: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of criterion.matchAll(QUOTED_TERM)) {
    const term = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const key = term.toLowerCase();
    if (term === "" || slugify(term) === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * The first quoted criterion term the page's own text really mentions.
 *
 * @param body - The article's rendered body.
 * @param terms - The criterion's quoted terms, in criterion order.
 * @returns The matched term as the article writes it, or null when the article
 *   satisfies none of them (which means the article does not belong in the category).
 */
export function matchingCriterionTerm(body: string, terms: readonly string[]): string | null {
  return firstPlainMention(body, terms)?.text ?? null;
}

/**
 * The evidence key recorded for a member admitted by one term.
 *
 * Computed with the same rule category ids are minted with, so a reader can recompute
 * it from the stored criterion and confirm which term admitted the page.
 *
 * @param term - The criterion term the article mentions.
 * @returns Its canonical key.
 */
export function evidenceKeyFor(term: string): string {
  return criterionKeyFor(term);
}
