/**
 * @file test/dimensions/row-page-categories.test.ts
 * @description Categories and their membership evidence persist in the STACK, and the
 * criterion that admits a page is still enforced against the page the wiki serves (S4).
 *
 * ## The gap this file closes
 *
 * A category lived only in `wiki/categories/<categoryId>.md` -- a directory on whichever
 * host compiled. A Stack whose pages live in rows therefore had no taxonomy at all, and
 * two hosts serving one Stack disagreed about which pages belong where. `wiki.categories`
 * and `wiki.category_members` exist for that; this file proves the COMPILE PATH writes
 * them and that a later run reads the membership back.
 *
 * ## What each case is allowed to prove
 *
 *  - the stored taxonomy is read with SQL (`test/fixtures/category-rows.ts`), not through
 *    the store under test: a writer and a reader broken in the same direction would agree
 *    with each other and prove nothing.
 *  - every field is asserted, because a store that keeps the name and loses the criterion
 *    cannot enforce anything: `category_id`, `canonical_name`, `description`,
 *    `inclusion_criterion` and both timestamps.
 *  - the membership row is asserted field for field -- `page_id`, `reason`, `evidence_key`
 *    -- and re-derived from the stored criterion and the stored page text, which is what
 *    makes membership auditable months later.
 *  - the parity case runs the same scenario twice, once row-backed and once file-backed,
 *    and compares the records, the evidence and the run's own reporting line.
 *
 * Every case drives `compileAndReport` on a real Stack with the real document store: a
 * store that only works when a test calls it directly proves nothing about the compile
 * path (S8).
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { compileAndReport } from "../../src/compiler/index.js";
import { categoryObjectId } from "../../src/categories/identity.js";
import { criterionTerms, evidenceKeyFor, matchingCriterionTerm } from "../../src/categories/criteria.js";
import { getStoredPage } from "../../src/dimensions/wiki/page-store.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";
import {
  answerFor,
  categoryLines,
  categoryRows,
  memberRows,
  parityRoots,
  saveScenarioSources,
  storeFor,
  stubCategoryCompile,
  withoutStack,
} from "../fixtures/category-rows.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import {
  CATEGORY_CRITERION,
  CATEGORY_DESCRIPTION,
  CATEGORY_REASON,
  SISTEMAS_TITLE,
  proposal,
  readCategoryRecord,
  sistemasProposal,
} from "../fixtures/category-scenario.js";

/** The category the sistemas article proposes, named exactly like the article. */
const CATEGORY_ID = "sistemas-distribuidos";

/** The per-record line a compile prints for the taxonomy it wrote. */
const REPORT_LINE = "Categories: 1 page(s) assigned to 1 category(ies) (1 new).";

/** What one backend's run of the scenario produced, as the two are compared. */
interface ScenarioResult {
  category: Record<string, unknown> | undefined;
  reported: string;
}

/**
 * Run the WHOLE scenario -- one refused proposal and one accepted -- and collect it.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 * @returns The stored category plus the run's reporting line.
 */
async function runScenario(
  root: string,
  harness?: KgPostgresHarness,
): Promise<ScenarioResult> {
  await saveScenarioSources(root, harness);
  stubCategoryCompile(answerFor([
    proposal({ name: "Kubernetes", criterion: 'Páginas que mencionen "kubernetes".' }),
    sistemasProposal(),
  ]));
  const io = captureProcessIo();
  await compileAndReport(root);
  const category = harness === undefined
    ? await readCategoryRecord(root, CATEGORY_ID)
    : (await storeFor(harness).read(CATEGORY_ID)) ?? undefined;
  return {
    category: category === undefined ? undefined : {
      categoryId: category.categoryId,
      canonicalName: category.canonicalName,
      description: category.description,
      inclusionCriterion: category.inclusionCriterion,
      members: category.members,
    },
    reported: categoryLines(io.out()),
  };
}

describe("categories through the row seam", () => {
  it("stores the category a compile assigned, with every field", () =>
    withRowsStack("row-category-fields", async ({ root, harness }) => {
      await saveScenarioSources(root, harness);
      stubCategoryCompile(answerFor([sistemasProposal()]));

      const io = captureProcessIo();
      await compileAndReport(root);

      const rows = await categoryRows(harness);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.category_id).toBe(CATEGORY_ID);
      expect(row.canonical_name).toBe(SISTEMAS_TITLE);
      expect(row.description).toBe(CATEGORY_DESCRIPTION);
      expect(row.inclusion_criterion).toBe(CATEGORY_CRITERION);
      // The record reads back under the same identity, with the same instants: a fresh
      // category has nothing to distinguish, so `createdAt` equals `updatedAt`.
      const record = await storeFor(harness).read(CATEGORY_ID);
      expect(record?.createdAt).toBe(record?.updatedAt);
      expect(Date.parse(record?.createdAt ?? "")).toBe(new Date(row.created_at).getTime());
      expect(Date.parse(record?.updatedAt ?? "")).toBe(new Date(row.updated_at).getTime());
      expect(io.out()).toContain(REPORT_LINE);
    }));

  it("refuses an article that does not quote the criterion and keeps the term that admitted it", () =>
    withRowsStack("row-category-criterion", async ({ root, harness }) => {
      await saveScenarioSources(root, harness);
      stubCategoryCompile(answerFor([
        proposal({ name: "Kubernetes", criterion: 'Páginas que mencionen "kubernetes".' }),
        sistemasProposal(),
      ]));

      const io = captureProcessIo();
      await compileAndReport(root);

      // The criterion is executable: the proposal whose term the article never mentions
      // is refused and counted, and it creates nothing.
      expect(io.out()).toContain("1 refused (1 unsupported)");
      expect((await categoryRows(harness)).map((row) => row.category_id)).toEqual([CATEGORY_ID]);
      // The accepted membership records WHICH term admitted the page.
      const members = await memberRows(harness);
      expect(members).toHaveLength(1);
      expect(members[0].category_id).toBe(CATEGORY_ID);
      expect(members[0].page_id).toBe(`concepts/${CATEGORY_ID}`);
      expect(members[0].reason).toBe(CATEGORY_REASON);
      expect(members[0].evidence_key).toBe("consenso-distribuido");
    }));

  it("re-derives each membership from the stored criterion and the stored page", () =>
    withRowsStack("row-category-evidence", async ({ root, harness }) => {
      await saveScenarioSources(root, harness);
      stubCategoryCompile(answerFor([sistemasProposal()]));
      await compileAndReport(root);

      const [member] = await memberRows(harness);
      const category = await storeFor(harness).read(CATEGORY_ID);
      const page = await getStoredPage(harness.db, harness.stackId, "concepts", CATEGORY_ID);

      // Months later, with nothing but the rows: the criterion still quotes the words,
      // and the page the wiki serves still mentions one of them.
      const term = matchingCriterionTerm(
        page?.body ?? "",
        criterionTerms(category?.inclusionCriterion ?? ""),
      );
      expect(term).not.toBeNull();
      expect(evidenceKeyFor(term ?? "")).toBe(member.evidence_key);
      expect(page?.body).toContain(term ?? "");
      expect(member.reason).toBe(CATEGORY_REASON);
    }));

  it("keeps a category and a concept of the same name as two objects", () =>
    withRowsStack("row-category-collision", async ({ root, harness }) => {
      await saveScenarioSources(root, harness);
      stubCategoryCompile(answerFor([sistemasProposal()]));
      await compileAndReport(root);

      const page = await getStoredPage(harness.db, harness.stackId, "concepts", CATEGORY_ID);
      expect(page?.title).toBe(SISTEMAS_TITLE);
      // Two objects, two identities: the category is addressed as `categories/<id>` and
      // the concept as a page row, and neither listing answers for the other.
      const listed = await storeFor(harness).list();
      expect(listed.map((record) => record.categoryId)).toEqual([CATEGORY_ID]);
      expect(listed.map((record) => categoryObjectId(record.categoryId)))
        .not.toContain(`concepts/${CATEGORY_ID}`);
      const directories = await harness.db.execute<{ page_directory: string }>(sql`
        select distinct page_directory from wiki.pages where stack_id = ${harness.stackId}
      `);
      expect(directories.map((row) => row.page_directory)).not.toContain("categories");
      // Renaming the category cannot move the page, and the page keeps its own bytes.
      const bodyBefore = page?.body;
      await storeFor(harness).update(CATEGORY_ID, { canonicalName: "Taxonomía distribuida" });
      const after = await getStoredPage(harness.db, harness.stackId, "concepts", CATEGORY_ID);
      expect(after?.title).toBe(SISTEMAS_TITLE);
      expect(after?.body).toBe(bodyBefore);
      expect((await categoryRows(harness)).map((row) => row.category_id)).toEqual([CATEGORY_ID]);
    }));

  it("stores, refuses and reports exactly what the file path does", () =>
    withRowsStack("row-category-parity", async ({ root, harness }) => {
      const { filesRoot, rowsRoot } = await parityRoots(root);

      const fromFiles = await withoutStack(() => runScenario(filesRoot));
      const fromRows = await runScenario(rowsRoot, harness);

      expect(fromFiles.category).toBeDefined();
      expect(fromRows.category).toEqual(fromFiles.category);
      expect(fromRows.reported).toBe(fromFiles.reported);
      expect(fromRows.reported).toContain("1 refused (1 unsupported)");
      expect(fromRows.reported).toContain("1 page(s) assigned to 1 category(ies) (1 new)");
    }));
});
