/**
 * @file test/dimensions/row-category-identity.test.ts
 * @description A row-backed category keeps its IDENTITY through a rename, and a create
 * never overwrites what the Stack already holds (S4, D4).
 *
 * ## Why these rules are measured on the store and not through a compile
 *
 * A compile can CREATE a category and can add members to it; it never renames one. The
 * rename rule -- "identity is minted once and never recomputed" -- therefore has exactly
 * one caller-visible entry point, the store's `update`, and a test that reached around it
 * would be measuring nothing. The compile's own half (a run really writes the rows) is
 * `row-page-categories.test.ts`; this file takes a category that a real compile created
 * and asks the store what a rename does to it.
 *
 * ## What each case is allowed to prove
 *
 *  - the `category_id` COLUMN is asserted with SQL before and after the rename, because a
 *    store that re-minted the id and one that kept it both read back a record: only the
 *    column tells them apart.
 *  - `created_at` is asserted unchanged and `updated_at` moved, so "preserved across
 *    updates" is a measurement rather than a comment.
 *  - a create against a taken identity is refused with the same typed error the file path's
 *    trust planner raises, and the stored row is unchanged afterwards -- a refusal that
 *    still wrote would be the silent overwrite S4 forbids.
 */

import { describe, expect, it } from "vitest";
import { compileAndReport } from "../../src/compiler/index.js";
import { CategoryWriteRefusedError } from "../../src/categories/types.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import {
  answerFor,
  categoryRows,
  saveScenarioSources,
  storeFor,
  stubCategoryCompile,
} from "../fixtures/category-rows.js";
import {
  CATEGORY_CRITERION,
  CATEGORY_DESCRIPTION,
  SISTEMAS_TITLE,
  sistemasProposal,
} from "../fixtures/category-scenario.js";

/** The category the article proposes, named exactly like the article. */
const CATEGORY_ID = "sistemas-distribuidos";

/**
 * Compile the scenario into the Stack, creating the category for real.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack.
 */
async function compileCategory(root: string, harness: KgPostgresHarness): Promise<void> {
  await saveScenarioSources(root, harness);
  stubCategoryCompile(answerFor([sistemasProposal()]));
  await compileAndReport(root);
}

describe("row-backed category identity", () => {
  it("mints the id once and never recomputes it on rename", () =>
    withRowsStack("row-category-rename", async ({ root, harness }) => {
      await compileCategory(root, harness);
      const [created] = await categoryRows(harness);
      expect(created.category_id).toBe(CATEGORY_ID);

      const renamed = await storeFor(harness)
        .update(CATEGORY_ID, { canonicalName: "Taxonomía distribuida" });

      // The ID did not move: the row still answers to the id it was minted with, which is
      // what keeps every reference to the category valid across the rename.
      const [after] = await categoryRows(harness);
      expect(after.category_id).toBe(created.category_id);
      expect(after.canonical_name).toBe("Taxonomía distribuida");
      expect(renamed.record.categoryId).toBe(CATEGORY_ID);
      expect(renamed.objectId).toBe(`categories/${CATEGORY_ID}`);
      // Creation happened once; only the last-write stamp moves.
      expect(new Date(after.created_at).toISOString())
        .toBe(new Date(created.created_at).toISOString());
      expect(new Date(after.updated_at).getTime())
        .toBeGreaterThan(new Date(created.updated_at).getTime());
      // And the record reads back under that same identity, with the new name.
      const read = await storeFor(harness).read(CATEGORY_ID);
      expect(read?.canonicalName).toBe("Taxonomía distribuida");
      expect(read?.createdAt).toBe(new Date(after.created_at).toISOString());
    }));

  it("refuses to create an identity the Stack already holds, and changes nothing", () =>
    withRowsStack("row-category-create-collision", async ({ root, harness }) => {
      await compileCategory(root, harness);
      const store = storeFor(harness);
      const before = await store.read(CATEGORY_ID);
      expect(before?.description).toBe(CATEGORY_DESCRIPTION);
      expect(before?.inclusionCriterion).toBe(CATEGORY_CRITERION);

      const refused = await store.create({
        canonicalName: SISTEMAS_TITLE,
        description: "Otra descripción.",
        inclusionCriterion: 'Páginas que mencionen "consenso distribuido".',
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(CategoryWriteRefusedError);
      expect((refused as CategoryWriteRefusedError).decision).toBe("deny");
      // A refused create writes NOTHING: the stored category is exactly what it was.
      expect(await store.read(CATEGORY_ID)).toEqual(before);
      expect(await categoryRows(harness)).toHaveLength(1);
    }));
});
