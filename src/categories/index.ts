/**
 * @file Public surface of the CATEGORY object: model, renderer, parser and store.
 *
 * A category is a second OBJECT TYPE next to the concept/page. It has its own
 * identity (`categoryId`, minted once from the canonical name), its own file
 * (`wiki/categories/<categoryId>.md`) and its own fields — canonical name,
 * description, inclusion criterion, members — and it may legitimately share a name
 * with a concept without either absorbing the other. Nothing exported here treats a
 * category as a page or a page as a category.
 */

export { categoryIdForName, categoryObjectId } from "./identity.js";
export { parseCategory, renderCategory } from "./markdown.js";
export { createCategory, listCategories, readCategory, updateCategory } from "./store.js";
export type {
  CategoryDraft,
  CategoryMemberDraft,
  CategoryPatch,
  CategoryRecord,
  CategoryRender,
  CategoryWriteResult,
  MemberTruncation,
} from "./types.js";
export {
  CategoryNotFoundError,
  CategoryValidationError,
  CategoryWriteRefusedError,
} from "./types.js";
