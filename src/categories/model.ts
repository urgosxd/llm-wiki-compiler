/**
 * @file Building and patching category records, with the required fields enforced.
 *
 * Non-empty text is checked by {@link requireText} (one definition shared with the
 * parser), member entries by {@link normalizeMembers} (which also mints each entry's
 * evidence key from the criterion when the caller supplies none), and the identity by
 * `identity.ts`. This module only decides WHAT the record is.
 *
 * Two entry points, both total: a draft becomes a new record, and a patch becomes an
 * updated record. Every required field (S10: stable identity, canonical name,
 * description, inclusion criterion) is validated on the way in, and a missing or
 * blank one raises a typed {@link CategoryValidationError} instead of a default —
 * a category with an empty description or an empty inclusion criterion answers
 * neither "what is this" nor "what belongs here", so storing it would be worse than
 * refusing it.
 *
 * The identity rules live in `identity.ts`: `categoryId` is minted from the name at
 * creation ({@link buildCategoryRecord}) and carried through unchanged by
 * {@link mergeCategoryPatch}, which is why a rename cannot move it.
 */

import { categoryIdForName, requireCategoryId } from "./identity.js";
import { criterionKeyFor, normalizeMembers } from "./members.js";
import { requireText } from "./validation.js";
import type { CategoryDraft, CategoryField, CategoryPatch, CategoryRecord } from "./types.js";

/**
 * Build the record for a NEW category from a caller's draft.
 *
 * The id is derived here, once, from the canonical name; the timestamps are the same
 * instant, because a record created and never updated has nothing to distinguish.
 *
 * @param draft - The caller's draft.
 * @param now - ISO timestamp to stamp as both `createdAt` and `updatedAt`.
 * @returns A complete, validated record.
 * @throws {CategoryValidationError} On a missing required field or an unusable name.
 */
export function buildCategoryRecord(draft: CategoryDraft, now: string): CategoryRecord {
  const canonicalName = requireText(draft.canonicalName, "canonicalName");
  const inclusionCriterion = requireText(draft.inclusionCriterion, "inclusionCriterion");
  return {
    categoryId: categoryIdForName(canonicalName),
    canonicalName,
    description: requireText(draft.description, "description"),
    inclusionCriterion,
    members: normalizeMembers(draft.members, criterionKeyFor(inclusionCriterion)),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply a partial change to an existing record.
 *
 * `categoryId` and `createdAt` are carried through untouched — identity is stable
 * and creation happened once — while `updatedAt` moves to the supplied instant.
 * A field absent from the patch keeps its stored value; a field present but blank is
 * REFUSED, so "clearing" a required field is an error rather than a silent wipe.
 *
 * @param record - The stored record.
 * @param patch - The fields to change.
 * @param now - ISO timestamp to stamp as `updatedAt`.
 * @returns The updated, validated record.
 * @throws {CategoryValidationError} When a supplied field is blank or not a string.
 */
export function mergeCategoryPatch(
  record: CategoryRecord,
  patch: CategoryPatch,
  now: string,
): CategoryRecord {
  const inclusionCriterion = pickText(
    patch.inclusionCriterion,
    record.inclusionCriterion,
    "inclusionCriterion",
  );
  return {
    categoryId: requireCategoryId(record.categoryId),
    canonicalName: pickText(patch.canonicalName, record.canonicalName, "canonicalName"),
    description: pickText(patch.description, record.description, "description"),
    inclusionCriterion,
    members:
      patch.members === undefined
        ? record.members
        : normalizeMembers(patch.members, criterionKeyFor(inclusionCriterion)),
    createdAt: record.createdAt,
    updatedAt: now,
  };
}

/**
 * Choose a patched value or keep the stored one.
 *
 * @param supplied - The patch's value, when it has one.
 * @param stored - The value already recorded.
 * @param field - Field name reported by the error.
 * @returns The new value when supplied, else the stored one.
 * @throws {CategoryValidationError} When the supplied value is blank or not a string.
 */
function pickText(supplied: unknown, stored: string, field: CategoryField): string {
  return supplied === undefined ? stored : requireText(supplied, field);
}
