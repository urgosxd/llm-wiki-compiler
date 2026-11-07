/**
 * @file The category STORE: create, read, list and update `wiki/categories/<id>.md`.
 *
 * ## Why a file per category, and not a page or a derived artifact
 *
 * A category is not a page: `PageDirectory` (`src/export/types.ts`) and the SQL
 * `CHECK` on `page_directory` are closed sets, so recording N categories in the page
 * store would need a migration for an object type that is deliberately not a page.
 * It is not a derived artifact either: the artifact store keys on `(stack_id, kind)`
 * with a constrained `kind` and one row per kind, so it can hold one artifact of a
 * kind and not N categories. One markdown file per category therefore needs ZERO
 * migrations and ZERO closed-set changes, and it makes S4 structural: the concept
 * "Sistemas distribuidos" is `wiki/concepts/sistemas-distribuidos.md` and the
 * category of the same name is `wiki/categories/sistemas-distribuidos.md`, two files
 * that cannot merge by accident.
 *
 * ## Every write goes through the trust floor
 *
 * Writes are planned with {@link planPageMutation} as a RAW page target
 * (`{kind:"raw", directory:"categories", slug:categoryId}`), which is the same
 * machinery `review approve` and `compile` use for default pages: the planner derives
 * `wiki/categories/<id>.md`, runs the mandatory checks (path confinement, collision
 * unless an overwrite was declared, resource cap, frontmatter parse) and hands the
 * approved mutation to {@link applyApprovedMutations} — the locked, journalled
 * executor. Nothing in this module writes bytes itself, so a category file inherits
 * exactly the confinement and crash-recovery guarantees a concept page has. A
 * blocked plan raises {@link CategoryWriteRefusedError} and writes nothing.
 *
 * `directory: "categories"` is NOT in the page-directory closed set, and it does not
 * need to be: the raw-page floor validates the directory as a safe filename
 * component, not as a member of `PageDirectory`. Reads stay confined to
 * {@link CATEGORIES_DIR} and drop any entry that is not a regular in-directory file,
 * so a symlinked category file cannot leak bytes from outside the project.
 *
 * ## Reads never create anything
 *
 * A project with no categories has no `wiki/categories/` directory, and reading it
 * returns an empty list rather than creating one.
 *
 * ## Membership is stored as evidence
 *
 * A member entry carries the page id, the reason recorded when it was assigned and the
 * canonical key of the criterion (or name evidence) that justified it, so a category
 * file answers "why is this page here?" on its own. An entry with no reason is refused
 * before any plan exists (a typed `CategoryValidationError`), so no unjustified
 * membership can reach disk.
 */

import path from "path";
import { readdir } from "fs/promises";
import { planPageMutation } from "../trust/planner.js";
import { applyApprovedMutations, applyApprovedMutationsLocked } from "../trust/executor.js";
import type { PlannedMutation } from "../trust/planner.js";
import { CATEGORIES_DIR, CATEGORY_PAGE_NAMESPACE } from "../utils/constants.js";
import { safeReadFile } from "../utils/markdown.js";
import { confinedRegularFile, confineUnderRoot, safeRealpath } from "../utils/path-confine.js";
import { categoryObjectId, requireCategoryId } from "./identity.js";
import { renderCategory, parseCategory } from "./markdown.js";
import { buildCategoryRecord, mergeCategoryPatch } from "./model.js";
import {
  CategoryNotFoundError,
  CategoryValidationError,
  CategoryWriteRefusedError,
} from "./types.js";
import type {
  CategoryDraft,
  CategoryPatch,
  CategoryRecord,
  CategoryStoreOutcome,
  CategoryStorePort,
  CategoryWriteOptions,
  CategoryWriteResult,
  MemberTruncation,
} from "./types.js";

/**
 * The origin string category writes carry into the trust planner.
 *
 * Its own value, not `"compile"`: {@link resourceCapForOrigin} gives compile-origin
 * writes the large GENERATED_PAGE_MAX_CHARS cap sized for merged concept pages, and a
 * category record is a small structured document. Naming it separately also makes the
 * write attributable in the decision and journal records.
 */
const CATEGORY_ORIGIN = "category";

/** The file suffix every category file carries. */
const MARKDOWN_SUFFIX = ".md";

/** One planned category write, plus the bound the render hit. */
interface PlannedCategoryWrite {
  planned: PlannedMutation[];
  truncation?: MemberTruncation;
}

/**
 * Create a category: mint its id from the canonical name and write its file.
 *
 * @param root - Absolute project root the file must stay confined to.
 * @param draft - The category's canonical name, description, inclusion criterion and
 *   optional members.
 * @param options - Write seam options; see {@link CategoryWriteOptions}.
 * @returns The stored record, its object id, its absolute path and — when the member
 *   listing was capped — the truncation.
 * @throws {CategoryValidationError} When a required field is missing or unusable.
 * @throws {CategoryWriteRefusedError} When the trust planner refuses the write (for
 *   example because a category with that id already exists: creating never
 *   overwrites).
 */
export async function createCategory(
  root: string,
  draft: CategoryDraft,
  options: CategoryWriteOptions = {},
): Promise<CategoryWriteResult> {
  const record = buildCategoryRecord(draft, new Date().toISOString());
  return await writeCategory(root, record, false, options);
}

/**
 * Update an existing category.
 *
 * The identity and the FILE are preserved: only the fields in the patch change, plus
 * `updatedAt`. A rename therefore keeps every existing reference valid.
 *
 * @param root - Absolute project root.
 * @param categoryId - The stable id of the category to update.
 * @param patch - The fields to change; omitted fields keep their stored value.
 * @param options - Write seam options; see {@link CategoryWriteOptions}.
 * @returns The stored record, its object id, its absolute path and any truncation.
 * @throws {CategoryNotFoundError} When no category file exists for the id.
 * @throws {CategoryValidationError} When a supplied field is blank or not a string.
 * @throws {CategoryWriteRefusedError} When the trust planner refuses the write.
 */
export async function updateCategory(
  root: string,
  categoryId: string,
  patch: CategoryPatch,
  options: CategoryWriteOptions = {},
): Promise<CategoryWriteResult> {
  const existing = await readCategory(root, categoryId);
  if (existing === null) throw new CategoryNotFoundError(categoryId);
  return await writeCategory(
    root, mergeCategoryPatch(existing, patch, new Date().toISOString()), true, options,
  );
}

/**
 * Read one category file.
 *
 * @param root - Absolute project root.
 * @param categoryId - The category's stable id.
 * @returns The stored record, or `null` when there is no such category.
 * @throws {CategoryValidationError} When the id is not a safe filename component, the
 *   file is not a valid category, or the file's declared `categoryId` is not the id
 *   the file is named after (identity and file name must agree, or a rename could
 *   silently point an id at another category).
 */
export async function readCategory(root: string, categoryId: string): Promise<CategoryRecord | null> {
  const content = await readCategoryContent(root, requireCategoryId(categoryId));
  if (content === null) return null;
  const record = parseCategory(content);
  if (record.categoryId !== categoryId) {
    throw new CategoryValidationError(
      "categoryId",
      `category file "${categoryId}${MARKDOWN_SUFFIX}" declares categoryId "${record.categoryId}"`,
    );
  }
  return record;
}

/**
 * The confined FILE backend, as the port every category consumer takes.
 *
 * ## Why the backend is decided here and not at each call site
 *
 * A category lives in `wiki/categories/<categoryId>.md` for a file-backed project and in
 * `wiki.categories` rows for a Stack (`src/dimensions/wiki/categories-row-store.ts`).
 * Both answer the same four operations, so the assignment stage asks the PORT and never
 * the file, and the backend is chosen once — by the compile's seam, from the same Stack
 * variable that decides where pages go. Without that, every caller would decide for
 * itself, which is how a run ends up writing its pages to rows and its categories to a
 * directory a Stack never reads.
 *
 * The port is BEHAVIOUR-PRESERVING for the file path: it delegates to the functions
 * above, unchanged, so a caller that installs nothing keeps exactly what it had.
 *
 * @param root - Absolute project root the writes are confined under.
 * @returns The file-backed port.
 */
export function createFileCategoryStore(root: string): CategoryStorePort {
  return {
    create: async (draft, options) => outcomeOf(await createCategory(root, draft, options)),
    read: async (categoryId) => await readCategory(root, categoryId),
    list: async () => await listCategories(root),
    update: async (categoryId, patch, options) =>
      outcomeOf(await updateCategory(root, categoryId, patch, options)),
  };
}

/**
 * The port's answer for one write, from the file store's own result.
 *
 * The path and the object id stay on {@link CategoryWriteResult} because they are what a
 * file caller reports; the port carries the identity and the record, which is what both
 * backends can answer.
 *
 * @param stored - The file store's result.
 * @returns The outcome the port reports.
 */
function outcomeOf(stored: CategoryWriteResult): CategoryStoreOutcome {
  return {
    record: stored.record,
    objectId: stored.objectId,
    ...(stored.truncation === undefined ? {} : { truncation: stored.truncation }),
  };
}

/**
 * List every category in the project, in ascending id order.
 *
 * @param root - Absolute project root.
 * @returns The stored records; an empty array when the project has no categories,
 *   including when it has no `wiki/categories/` directory at all.
 * @throws {CategoryValidationError} When a category file in the directory is invalid.
 */
export async function listCategories(root: string): Promise<CategoryRecord[]> {
  const records: CategoryRecord[] = [];
  for (const categoryId of await listCategoryIds(root)) {
    const record = await readCategory(root, categoryId);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * The ids of the category files present, sorted.
 *
 * @param root - Absolute project root.
 * @returns File stems without the `.md` suffix; `[]` when the directory is absent.
 */
async function listCategoryIds(root: string): Promise<string[]> {
  const dir = await safeRealpath(path.join(root, CATEGORIES_DIR));
  if (dir === null) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith(MARKDOWN_SUFFIX))
    .map((name) => name.slice(0, -MARKDOWN_SUFFIX.length))
    .sort();
}

/**
 * Read a category file's bytes through the confinement floor.
 *
 * @param root - Absolute project root.
 * @param categoryId - An already-validated id.
 * @returns The file's content, or `null` when it is absent or not a regular file
 *   inside the category directory (a symlinked leaf is refused, not followed).
 */
async function readCategoryContent(root: string, categoryId: string): Promise<string | null> {
  const dir = await safeRealpath(path.join(root, CATEGORIES_DIR));
  if (dir === null) return null;
  const file = await confinedRegularFile(dir, `${categoryId}${MARKDOWN_SUFFIX}`);
  return file === null ? null : safeReadFile(file);
}

/**
 * Render, plan and apply one category file through the trust seam.
 *
 * @param root - Absolute project root.
 * @param record - The complete record to store.
 * @param allowOverwrite - `true` for an update (an intended overwrite), `false` for a
 *   create (a colliding id is refused rather than replaced).
 * @param options - Write seam options; see {@link CategoryWriteOptions}.
 * @returns The write result.
 * @throws {CategoryWriteRefusedError} When the planner returns no live-write mutation.
 */
async function writeCategory(
  root: string,
  record: CategoryRecord,
  allowOverwrite: boolean,
  options: CategoryWriteOptions,
): Promise<CategoryWriteResult> {
  const { planned, truncation } = await planCategoryWrite(root, record, allowOverwrite);
  await applyCategoryMutations(root, planned, options.lockHeld === true);
  return {
    record,
    objectId: categoryObjectId(record.categoryId),
    path: await categoryFilePath(root, record.categoryId),
    ...(truncation === undefined ? {} : { truncation }),
  };
}

/**
 * Hand the plan to the executor, acquiring the project lock unless the caller holds it.
 *
 * WHY THE OPTION EXISTS. A compile holds the project lock for its WHOLE pipeline, and
 * the category assignment stage runs inside it, so a nested acquisition there is refused
 * ("another compilation is running") and every category write of the run would be lost
 * while the run reported success. `applyApprovedMutationsLocked` is the SAME locked,
 * journalled executor without the re-acquisition -- the seam every other compile-path
 * writer uses -- so the compile passes `lockHeld` and nothing else changes. The default
 * is to acquire, so a caller outside the compile keeps the ordinary guarantee.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations.
 * @param lockHeld - True when the caller already holds the project lock.
 */
async function applyCategoryMutations(
  root: string,
  planned: PlannedMutation[],
  lockHeld: boolean,
): Promise<void> {
  if (lockHeld) {
    await applyApprovedMutationsLocked(root, planned);
    return;
  }
  await applyApprovedMutations(root, planned);
}

/**
 * Plan one category write as a RAW page mutation under `wiki/categories/`.
 *
 * @param root - Absolute project root.
 * @param record - The record to render and plan.
 * @param allowOverwrite - Whether an existing file is an intended overwrite.
 * @returns The approved mutations and the render's truncation, if any.
 * @throws {CategoryWriteRefusedError} When the planner refuses (no planned mutation).
 */
async function planCategoryWrite(
  root: string,
  record: CategoryRecord,
  allowOverwrite: boolean,
): Promise<PlannedCategoryWrite> {
  const { markdown, truncation } = renderCategory(record);
  const { planned, decision } = await planPageMutation({
    root,
    target: { kind: "raw", directory: CATEGORY_PAGE_NAMESPACE, slug: requireCategoryId(record.categoryId) },
    body: markdown,
    origin: CATEGORY_ORIGIN,
    reviewRouted: false,
    allowOverwrite,
  });
  if (planned.length === 0) throw new CategoryWriteRefusedError(decision);
  return { planned, ...(truncation === undefined ? {} : { truncation }) };
}

/**
 * The absolute path of a category's file, confined under the project root.
 *
 * @param root - Absolute project root.
 * @param categoryId - An already-validated id.
 * @returns The absolute path the planner writes for that id.
 */
async function categoryFilePath(root: string, categoryId: string): Promise<string> {
  return await confineUnderRoot(path.join(CATEGORIES_DIR, `${categoryId}${MARKDOWN_SUFFIX}`), root, {
    mustExist: false,
  });
}
