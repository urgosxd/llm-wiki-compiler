/**
 * @file Category member entries: validation, evidence keys, and the one stored order.
 *
 * ## Why an entry and not an id
 *
 * The inclusion criterion states which pages belong in general; a member entry records
 * why a SPECIFIC page was assigned, together with the canonical key of the evidence it
 * was judged against. Without that, membership is an opinion that drifts silently and
 * nobody can audit later why a page was there.
 *
 * ## The evidence key is recorded, not re-derived
 *
 * A caller may justify a member by the category's own criterion (the common case) or by
 * other name evidence. When no key is supplied, the criterion's canonical key is
 * recorded — computed with the same {@link slugify} rule category ids use, so the key
 * can be recomputed from the stored criterion to audit it. The stored key is never
 * recomputed on a later criterion edit: it is evidence of what justified the page at
 * assignment time.
 *
 * ## Missing reason is a refusal, not a default
 *
 * An entry with no reason, or a blank one, raises a typed
 * {@link CategoryValidationError} (`memberReason`) and nothing is written. The
 * alternative — storing a member nobody can explain — is exactly the drift this exists
 * to prevent.
 *
 * ## One stored order
 *
 * Entries are deduplicated by page id and ordered by page id, then reason, then evidence
 * key (UTF-16 code-unit comparison, locale-independent). The result depends only on the
 * SET of entries, never on the order the caller supplied, so a category file is diffable
 * and two runs can be compared byte for byte. When the same page id appears twice with
 * different justifications, the canonically smallest one is kept — a rule that is
 * deterministic and order-independent, rather than "the last one wins".
 */

import { slugify } from "../utils/markdown.js";
import { requireText } from "./validation.js";
import { CategoryValidationError } from "./types.js";
import type { CategoryMember, CategoryMemberDraft } from "./types.js";

/**
 * The canonical key of an evidence text (an inclusion criterion or a page name).
 *
 * @param text - The evidence text.
 * @returns Its slug, the same rule category ids are minted with.
 * @throws {CategoryValidationError} When the text contains no letter or digit, so no
 *   key can be derived from it — the caller must then supply an explicit key.
 */
export function criterionKeyFor(text: string): string {
  const key = slugify(text);
  if (key === "") {
    throw new CategoryValidationError(
      "memberEvidence",
      `evidence text ${JSON.stringify(text)} contains no letter or digit, so no canonical key can be derived`,
    );
  }
  return key;
}

/**
 * Validate a caller's member entries, fill in the evidence key, and put them in the
 * stored order.
 *
 * @param members - The entries as supplied, in any order (may be undefined).
 * @param criterionKey - The key to record for entries that supply none.
 * @returns The validated, deduplicated, ordered entries.
 * @throws {CategoryValidationError} When the list is not a list, an entry is not an
 *   object, or a required part of an entry is missing or blank.
 */
export function normalizeMembers(
  members: readonly CategoryMemberDraft[] | undefined,
  criterionKey: string,
): CategoryMember[] {
  if (members === undefined) return [];
  if (!Array.isArray(members)) {
    throw new CategoryValidationError("members", "category members must be a list of member entries");
  }
  return sortMembers(members.map((member) => requireMember(member, criterionKey)));
}

/**
 * Validate one member entry.
 *
 * @param member - The entry as supplied.
 * @param criterionKey - The key recorded when the entry supplies none.
 * @returns The complete entry.
 * @throws {CategoryValidationError} When the entry is not an object or a part is
 *   missing or blank.
 */
function requireMember(member: CategoryMemberDraft, criterionKey: string): CategoryMember {
  if (typeof member !== "object" || member === null) {
    throw new CategoryValidationError("members", "each category member must be an entry, not a bare value");
  }
  return {
    pageId: requireText(member.pageId, "memberPageId"),
    reason: requireText(member.reason, "memberReason"),
    evidenceKey:
      member.evidenceKey === undefined || member.evidenceKey === null
        ? criterionKey
        : requireText(member.evidenceKey, "memberEvidence"),
  };
}

/**
 * Deduplicate and order member entries.
 *
 * @param entries - Complete entries, in any order.
 * @returns A new array: one entry per page id, ascending by page id.
 */
export function sortMembers(entries: readonly CategoryMember[]): CategoryMember[] {
  const sorted = [...entries].sort(compareMembers);
  const unique: CategoryMember[] = [];
  for (const entry of sorted) {
    const previous = unique[unique.length - 1];
    if (previous === undefined || previous.pageId !== entry.pageId) unique.push(entry);
  }
  return unique;
}

/**
 * Total order over entries: page id, then reason, then evidence key.
 *
 * @param left - First entry.
 * @param right - Second entry.
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects.
 */
function compareMembers(left: CategoryMember, right: CategoryMember): number {
  const byPage = compareText(left.pageId, right.pageId);
  if (byPage !== 0) return byPage;
  const byReason = compareText(left.reason, right.reason);
  return byReason === 0 ? compareText(left.evidenceKey, right.evidenceKey) : byReason;
}

/**
 * Compare two strings by UTF-16 code unit.
 *
 * Spelled out instead of `localeCompare` so member order cannot depend on the host's
 * locale.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero or positive.
 */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
