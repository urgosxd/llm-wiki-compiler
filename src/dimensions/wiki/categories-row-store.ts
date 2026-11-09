/**
 * @file src/dimensions/wiki/categories-row-store.ts
 * @description The category STORE, backed by `wiki.categories` + `wiki.category_members`
 * rows (S4, D4).
 *
 * ## Why this exists, and what it is NOT
 *
 * A category used to live only in `wiki/categories/<categoryId>.md` -- a directory on the
 * host that compiled. A Stack whose pages live in rows therefore had no taxonomy at all:
 * nothing recorded which pages belong together, and two hosts serving one Stack disagreed
 * about it. `wiki.categories` closes half of that and `wiki.category_members` the other:
 * one row per category, carrying its identity, canonical name, description and inclusion
 * criterion, and one row per member, carrying the page, the reason it was admitted and
 * the canonical key of the evidence that admitted it.
 *
 * This module is a BACKEND, not a second implementation. Everything that DECIDES what a
 * category is lives in `src/categories/` and is called here rather than restated:
 * `buildCategoryRecord` and `mergeCategoryPatch` (the model and its required fields),
 * `categoryIdForName` through that builder (identity minted once, never recomputed),
 * `categoryObjectId` (the namespaced object id) and `sortMembers` (the one stored order).
 * What differs is only where the records live.
 *
 * ## Identity is never recomputed
 *
 * The primary key is `(stack_id, category_id)`, and the update path below patches the
 * name, the description, the criterion and `updated_at` and NOTHING ELSE: `category_id`
 * never appears in an `update`. A rename therefore keeps every existing reference valid,
 * exactly as it does in the file path, where the file is named after the id and the id is
 * derived only at creation.
 *
 * ## Membership is evidence, not a bare list
 *
 * A member row carries `page_id`, `reason` and `evidence_key`. The criterion says which
 * pages belong in general; the row says why THIS page was put in, recorded at assignment
 * time, so months later the membership can be re-derived by re-running the criterion test
 * (`src/categories/criteria.ts`) against the page text and comparing the resulting key
 * with the stored one. A category and a CONCEPT of the same name stay two objects because
 * they live in two tables with two identities: `categories/<id>` is never `concepts/<id>`.
 *
 * ## Tenancy
 *
 * Every statement runs inside `withTenant`, which binds `app.stack_id` for the
 * transaction. The tables have RLS forced, so a statement that forgot the bind would see
 * no rows rather than another Stack's -- but binding here is what makes the reads and
 * writes of one run address one Stack, and it matches every other row store in this layer.
 */

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import { buildCategoryRecord, mergeCategoryPatch } from "../../categories/model.js";
import { categoryObjectId, requireCategoryId } from "../../categories/identity.js";
import { sortMembers } from "../../categories/members.js";
import {
  CategoryNotFoundError,
  CategoryWriteRefusedError,
  type CategoryDraft,
  type CategoryMember,
  type CategoryPatch,
  type CategoryRecord,
  type CategoryStoreOutcome,
  type CategoryStorePort,
} from "../../categories/types.js";
import { withTenant } from "./page-store.js";

/** One `wiki.categories` row, as Postgres returns it. */
interface CategoryRow extends Record<string, unknown> {
  readonly category_id: string;
  readonly canonical_name: string;
  readonly description: string;
  readonly inclusion_criterion: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/** One `wiki.category_members` row, as Postgres returns it. */
interface MemberRow extends Record<string, unknown> {
  readonly category_id: string;
  readonly page_id: string;
  readonly reason: string;
  readonly evidence_key: string;
}

/** The category columns every statement here names. */
const CATEGORY_COLUMNS = sql`
  category_id, canonical_name, description, inclusion_criterion, created_at, updated_at
`;

/** The member columns every statement here names. */
const MEMBER_COLUMNS = sql`category_id, page_id, reason, evidence_key`;

/**
 * One stored row, plus its members, as the record the file store hands the same consumers.
 *
 * `created_at`/`updated_at` arrive as `Date` because the columns are `timestamptz`; they
 * are rendered back to the ISO strings the record carries on both backends, so a reader
 * cannot tell which store answered. Members go through the shared `sortMembers`, so the
 * stored order (page id, then reason, then key) is one rule for both backends rather than
 * whatever order the database happens to return.
 *
 * @param row - The category row.
 * @param members - Its member rows.
 * @returns The record.
 */
function recordOf(row: CategoryRow, members: readonly CategoryMember[]): CategoryRecord {
  return {
    categoryId: row.category_id,
    canonicalName: row.canonical_name,
    description: row.description,
    inclusionCriterion: row.inclusion_criterion,
    members: sortMembers(members),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Every member row of one category, in the record's shape.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack that owns the rows.
 * @param categoryId - The category whose members to read.
 * @returns The member entries, unsorted (the caller applies the shared order).
 */
async function readMemberRows(
  tx: DatabaseHandle,
  stackId: string,
  categoryId: string,
): Promise<CategoryMember[]> {
  const rows = await tx.execute<MemberRow>(sql`
    select ${MEMBER_COLUMNS}
    from wiki.category_members
    where stack_id = ${stackId} and category_id = ${categoryId}
  `);
  return rows.map(memberOf);
}

/**
 * One member row as the entry the record carries.
 *
 * @param row - The row as Postgres returned it.
 * @returns The member entry.
 */
function memberOf(row: MemberRow): CategoryMember {
  return { pageId: row.page_id, reason: row.reason, evidenceKey: row.evidence_key };
}

/**
 * One stored category, or null when this Stack has none under that id.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack that owns the category.
 * @param categoryId - The identity to read.
 * @returns The record, or null.
 * @throws {CategoryValidationError} When the id is not a safe filename component.
 */
async function readOneTx(
  tx: DatabaseHandle,
  stackId: string,
  categoryId: string,
): Promise<CategoryRecord | null> {
  const id = requireCategoryId(categoryId);
  const rows = await tx.execute<CategoryRow>(sql`
    select ${CATEGORY_COLUMNS}
    from wiki.categories
    where stack_id = ${stackId} and category_id = ${id}
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return recordOf(row, await readMemberRows(tx, stackId, id));
}

/**
 * Every stored category of one Stack, in ascending id order.
 *
 * Two statements rather than one join: a join would repeat a category row once per member
 * and make the grouping the reader's problem. The order is applied in code, by the same
 * code-unit comparison the file path sorts file stems with, so the two backends agree on
 * it regardless of the database's collation.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack whose categories to read.
 * @returns The records, empty when the Stack has no categories.
 */
async function readAllTx(tx: DatabaseHandle, stackId: string): Promise<CategoryRecord[]> {
  const categories = await tx.execute<CategoryRow>(sql`
    select ${CATEGORY_COLUMNS} from wiki.categories where stack_id = ${stackId}
  `);
  const members = await tx.execute<MemberRow>(sql`
    select ${MEMBER_COLUMNS} from wiki.category_members where stack_id = ${stackId}
  `);
  return categories
    .map((row) => recordOf(row, members.filter((member) => member.category_id === row.category_id).map(memberOf)))
    .sort((left, right) => compareIds(left.categoryId, right.categoryId));
}

/**
 * Compare two category ids by UTF-16 code unit, as the file path sorts file stems.
 *
 * @param left - First id.
 * @param right - Second id.
 * @returns Negative, zero or positive.
 */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Insert one category row. The caller has already established that no row exists.
 *
 * The primary key is the backstop, not the plan: a create refuses a taken identity before
 * building the insert (see {@link createInRows}), so this statement never silently
 * replaces a stored category.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack that will own the row.
 * @param record - The complete record to store.
 */
async function insertCategoryTx(tx: DatabaseHandle, stackId: string, record: CategoryRecord): Promise<void> {
  await tx.execute(sql`
    insert into wiki.categories
      (stack_id, category_id, canonical_name, description, inclusion_criterion, created_at, updated_at)
    values (
      ${stackId}, ${record.categoryId}, ${record.canonicalName}, ${record.description},
      ${record.inclusionCriterion}, ${record.createdAt}, ${record.updatedAt}
    )
  `);
}

/**
 * Patch an existing category row's mutable fields.
 *
 * `category_id` and `created_at` are absent from the statement on purpose: identity is
 * minted once and creation happened once, so a rename moves the name and nothing else.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack that owns the row.
 * @param record - The record carrying the new values.
 */
async function patchCategoryTx(tx: DatabaseHandle, stackId: string, record: CategoryRecord): Promise<void> {
  await tx.execute(sql`
    update wiki.categories
       set canonical_name = ${record.canonicalName},
           description = ${record.description},
           inclusion_criterion = ${record.inclusionCriterion},
           updated_at = ${record.updatedAt}
     where stack_id = ${stackId} and category_id = ${record.categoryId}
  `);
}

/**
 * Make the stored member rows equal the record's member set.
 *
 * The file backend stores the record's members and nothing else, so this backend does the
 * same: a page that left the set loses its row, and a page in the set keeps its evidence.
 * A row that stays is UPDATED rather than deleted and re-inserted, so the audit trail never
 * has a window where a membership does not exist.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack that owns the rows.
 * @param record - The record whose member set is authoritative.
 */
async function replaceMembersTx(tx: DatabaseHandle, stackId: string, record: CategoryRecord): Promise<void> {
  const stored = await readMemberRows(tx, stackId, record.categoryId);
  const keep = new Set(record.members.map((member) => member.pageId));
  for (const member of stored) {
    if (keep.has(member.pageId)) continue;
    await tx.execute(sql`
      delete from wiki.category_members
      where stack_id = ${stackId} and category_id = ${record.categoryId} and page_id = ${member.pageId}
    `);
  }
  for (const member of record.members) {
    await tx.execute(sql`
      insert into wiki.category_members (stack_id, category_id, page_id, reason, evidence_key)
      values (${stackId}, ${record.categoryId}, ${member.pageId}, ${member.reason}, ${member.evidenceKey})
      on conflict (stack_id, category_id, page_id) do update
        set reason = excluded.reason, evidence_key = excluded.evidence_key
    `);
  }
}

/** One write's answer, in the terms the port reports. */
function outcomeOf(record: CategoryRecord): CategoryStoreOutcome {
  return { record, objectId: categoryObjectId(record.categoryId) };
}

/**
 * Create one category from a draft, minting its identity from the canonical name.
 *
 * A create never overwrites, in either backend: the file path's trust planner refuses a
 * colliding path and this refuses a taken primary key, with the SAME error and the same
 * decision string, so a caller cannot tell which backend answered a collision.
 *
 * @param db - The database handle.
 * @param stackId - The Stack that will own the category.
 * @param draft - The category to create.
 * @returns The stored record and its object id.
 * @throws {CategoryValidationError} When a required field is missing or unusable.
 * @throws {CategoryWriteRefusedError} When the identity is already taken.
 */
async function createInRows(
  db: DatabaseHandle,
  stackId: string,
  draft: CategoryDraft,
): Promise<CategoryStoreOutcome> {
  const record = buildCategoryRecord(draft, new Date().toISOString());
  return await withTenant(db, stackId, async (tx) => {
    if (await readOneTx(tx, stackId, record.categoryId) !== null) {
      throw new CategoryWriteRefusedError("deny");
    }
    await insertCategoryTx(tx, stackId, record);
    await replaceMembersTx(tx, stackId, record);
    return outcomeOf(record);
  });
}

/**
 * Apply a partial change to one stored category, preserving its identity.
 *
 * @param db - The database handle.
 * @param stackId - The Stack that owns the category.
 * @param categoryId - The identity to update.
 * @param patch - The fields to change; omitted fields keep their stored value.
 * @returns The stored record and its object id.
 * @throws {CategoryNotFoundError} When the Stack holds no category under that id.
 * @throws {CategoryValidationError} When a supplied field is blank or not a string.
 */
async function updateInRows(
  db: DatabaseHandle,
  stackId: string,
  categoryId: string,
  patch: CategoryPatch,
): Promise<CategoryStoreOutcome> {
  return await withTenant(db, stackId, async (tx) => {
    const existing = await readOneTx(tx, stackId, categoryId);
    if (existing === null) throw new CategoryNotFoundError(categoryId);
    const record = mergeCategoryPatch(existing, patch, new Date().toISOString());
    await patchCategoryTx(tx, stackId, record);
    await replaceMembersTx(tx, stackId, record);
    return outcomeOf(record);
  });
}

/**
 * The Stack's rows, as the port every category consumer takes.
 *
 * The seam's answer for a project whose pages live in rows: the compile path resolves it
 * from the SAME Stack variable that decides the page seams, so a run cannot write its
 * pages to rows and leave its taxonomy in a directory a Stack never reads.
 *
 * `CategoryWriteOptions` (`lockHeld`) is accepted and ignored: it exists so the file
 * backend can reuse the already-held project lock, and rows have no project lock -- the
 * transaction opened here is the unit.
 *
 * @param db - The run's database handle.
 * @param stackId - The Stack to read and write.
 * @returns The row-backed port.
 */
export function createRowCategoryStore(db: DatabaseHandle, stackId: string): CategoryStorePort {
  return {
    create: async (draft) => await createInRows(db, stackId, draft),
    read: async (categoryId) =>
      await withTenant(db, stackId, async (tx) => await readOneTx(tx, stackId, categoryId)),
    list: async () => await withTenant(db, stackId, async (tx) => await readAllTx(tx, stackId)),
    update: async (categoryId, patch) => await updateInRows(db, stackId, categoryId, patch),
  };
}
