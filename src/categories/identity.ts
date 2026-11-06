/**
 * @file Category identity: minting an id, naming the object, guarding the file name.
 *
 * ## Identity is minted once
 *
 * `categoryId` is derived from the canonical name AT CREATION and never recomputed.
 * That single rule is what makes a rename safe: the file name and every link to the
 * category stay valid while the human-readable name changes, because nothing ever
 * re-derives the id from the current name. The alternative — an id that tracks the
 * name — would turn every rename into a delete plus a create and break every
 * reference silently.
 *
 * ## A category id is not a concept slug
 *
 * Both are derived by the same {@link slugify}, and that is exactly the point: the
 * same name yields the same stem in `wiki/concepts/` and in `wiki/categories/`, and
 * the two are still different objects because the DIRECTORY (and therefore the
 * object id, see {@link categoryObjectId}) differs. Prefixing the object id with the
 * namespace is what makes that checkable rather than assumed: `concepts/x` can never
 * equal `categories/x`.
 */

import { slugify } from "../utils/markdown.js";
import { isSafeFilenameComponent } from "../utils/page-identity.js";
import { CategoryValidationError } from "./types.js";

/** Path segment that makes a category's object id distinct from a page's. */
const CATEGORY_OBJECT_NAMESPACE = "categories";

/**
 * Derive the identity of a NEW category from its canonical name.
 *
 * Only ever called at creation: an existing category keeps its id even when its
 * canonical name changes.
 *
 * @param canonicalName - The (already validated, non-blank) canonical name.
 * @returns The slug used as the `categoryId` and as the file's stem.
 * @throws {CategoryValidationError} When the name contains no letter or digit, so
 *   no usable identity can be minted (writing `.md` for a nameless category would
 *   create a dotfile nobody can address).
 */
export function categoryIdForName(canonicalName: string): string {
  const categoryId = slugify(canonicalName);
  if (categoryId === "") {
    throw new CategoryValidationError(
      "canonicalName",
      `canonical name "${canonicalName}" contains no letter or digit, so no category id can be derived from it`,
    );
  }
  return categoryId;
}

/**
 * The object identity of a category: `categories/<categoryId>`.
 *
 * Never equal to a page id (`concepts/<slug>`, `queries/<slug>`) for the same name,
 * which is how a name collision stays two objects instead of one.
 *
 * @param categoryId - The category's stable id.
 * @returns The namespaced object id.
 */
export function categoryObjectId(categoryId: string): string {
  return `${CATEGORY_OBJECT_NAMESPACE}/${categoryId}`;
}

/**
 * Assert that an id can name a category FILE.
 *
 * The trust planner and executor both re-assert this floor, but checking here means
 * a caller passing `../escape` gets a typed refusal instead of a write attempt.
 *
 * @param categoryId - The id to check.
 * @returns The same id, unchanged, when it is a safe single path component.
 * @throws {CategoryValidationError} When it is not.
 */
export function requireCategoryId(categoryId: unknown): string {
  if (typeof categoryId !== "string" || !isSafeFilenameComponent(categoryId)) {
    throw new CategoryValidationError(
      "categoryId",
      `category id ${JSON.stringify(categoryId)} is not a safe filename component`,
    );
  }
  return categoryId;
}
