/**
 * @file Shared plumbing for the ROW-BACKED category suites.
 *
 * Two suites measure the same behaviour from different sides -- one through a real
 * compile (`row-page-categories.test.ts`), one at the store's identity rules
 * (`row-category-identity.test.ts`) -- and both need the same four things: the scenario's
 * two sources in the Stack AND on disk, a provider stub that answers the assignment call,
 * SQL readers that assert the ROWS rather than the store under test, and a way to run a
 * body with no Stack installed so the file backend answers instead.
 *
 * WHY THEY LIVE HERE. The first versions of the two suites each carried a copy, and
 * `fallow` reported five clone groups between them -- duplication in tests is duplication
 * of intent, so a change to the scenario would have had to be made twice.
 *
 * WHY THE ROWS ARE READ WITH SQL. A store asked to read its own write cannot tell a
 * missing row from a mis-read one: a writer and a reader broken in the same direction agree
 * perfectly and prove nothing. These readers are deliberately independent of
 * `categories-row-store.ts`.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createRowCategoryStore } from "../../src/dimensions/wiki/categories-row-store.js";
import { saveSourceDocument } from "../../src/dimensions/wiki/source-documents-store.js";
import type { CategoryStorePort } from "../../src/categories/types.js";
import { stubCompileProvider } from "./compile-provider.js";
import type { KgPostgresHarness } from "./kg-postgres.js";
import {
  ALMACENES_SOURCE,
  SISTEMAS_SOURCE,
  SISTEMAS_TITLE,
  bodyForArticle,
  extractionFor,
  proposalAnswer,
  titleForSource,
  writeScenarioSources,
} from "./category-scenario.js";

/** One `wiki.categories` row, as Postgres returns it. */
export interface CategoryRow extends Record<string, unknown> {
  readonly category_id: string;
  readonly canonical_name: string;
  readonly description: string;
  readonly inclusion_criterion: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/** One `wiki.category_members` row, as Postgres returns it. */
export interface MemberRow extends Record<string, unknown> {
  readonly category_id: string;
  readonly page_id: string;
  readonly reason: string;
  readonly evidence_key: string;
}

/**
 * The Stack's category rows, read with SQL.
 *
 * @param harness - The suite's Stack.
 * @returns The rows, in id order.
 */
export async function categoryRows(harness: KgPostgresHarness): Promise<CategoryRow[]> {
  return await harness.db.execute<CategoryRow>(sql`
    select * from wiki.categories where stack_id = ${harness.stackId} order by category_id asc
  `);
}

/**
 * The Stack's membership evidence, read with SQL.
 *
 * @param harness - The suite's Stack.
 * @returns The member rows, in category then page order.
 */
export async function memberRows(harness: KgPostgresHarness): Promise<MemberRow[]> {
  return await harness.db.execute<MemberRow>(sql`
    select * from wiki.category_members
    where stack_id = ${harness.stackId}
    order by category_id asc, page_id asc
  `);
}

/**
 * The row-backed store, for the operations a compile cannot express (a rename).
 *
 * @param harness - The suite's Stack.
 * @returns The port the compile path installs on its seams.
 */
export function storeFor(harness: KgPostgresHarness): CategoryStorePort {
  return createRowCategoryStore(harness.db, harness.stackId);
}

/**
 * Put the scenario's two sources into the Stack AND on disk.
 *
 * The on-disk copy is what lets the same corpus be replayed through the file-backed path,
 * and the row copies are what a Stack-backed compile actually reads. Writing both is the
 * only way one scenario can be run through both backends.
 *
 * @param root - Project root.
 * @param harness - The suite's Stack, or undefined for a file-backed root.
 */
export async function saveScenarioSources(
  root: string,
  harness: KgPostgresHarness | undefined,
): Promise<void> {
  await writeScenarioSources(root);
  if (harness === undefined) return;
  for (const source of [SISTEMAS_SOURCE, ALMACENES_SOURCE]) {
    await saveSourceDocument(harness.db, harness.stackId, {
      title: source.replace(/\.md$/u, ""),
      document: await readFile(path.join(root, "sources", source), "utf-8"),
      source,
    });
  }
}

/**
 * Answer each article's assignment call with its own proposals.
 *
 * Routing on the article title is safe here because the assignment prompt names ONE
 * article; the extraction prompt is the one that also carries the wiki index.
 *
 * @param sistemas - Proposals for the `Sistemas distribuidos` article.
 * @param almacenes - Proposals for the second article.
 * @returns The answer function.
 */
export function answerFor(
  sistemas: Record<string, unknown>[] = [],
  almacenes: Record<string, unknown>[] = [],
): (system: string) => string {
  return (system) =>
    system.includes(`Article to categorise: "${SISTEMAS_TITLE}"`)
      ? proposalAnswer(...sistemas)
      : proposalAnswer(...almacenes);
}

/**
 * Install the compile stub: extraction, page render and the category answer.
 *
 * @param answer - The assignment answer, from {@link answerFor}.
 */
export function stubCategoryCompile(answer: (system: string) => string): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  stubCompileProvider({
    extraction: (system) => extractionFor(titleForSource(system)),
    body: (system) => bodyForArticle(system),
    categories: answer,
  });
}

/**
 * Run `body` with NO Stack installed, so every seam resolves to the file backend.
 *
 * The WHOLE environment is restored rather than just `AKS_STACK_ID`, because a compile
 * also sets provider variables, and a suite that left one behind would decide which
 * provider the next test reaches for.
 *
 * @param body - Work to run without a Stack.
 * @returns Whatever `body` returns.
 */
export async function withoutStack<T>(body: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env = Object.fromEntries(
    Object.entries(saved).filter(([key]) => key !== "AKS_STACK_ID"),
  );
  try {
    return await body();
  } finally {
    process.env = saved;
  }
}

/**
 * Two sibling project roots inside one temp root, for a two-backend comparison.
 *
 * The file-backed half writes real page and category files, so it needs a root of its own;
 * sharing one would let the row-backed run consume what the file run wrote.
 *
 * @param root - The suite's temp root.
 * @returns The file-backed root and the row-backed root.
 */
export async function parityRoots(root: string): Promise<{ filesRoot: string; rowsRoot: string }> {
  const filesRoot = path.join(root, "files");
  const rowsRoot = path.join(root, "rows");
  await mkdir(filesRoot);
  await mkdir(rowsRoot);
  return { filesRoot, rowsRoot };
}

/**
 * The taxonomy lines a run printed, or "" when it printed none.
 *
 * @param printed - Everything the run wrote to stdout.
 * @returns The `Categories:` lines, joined.
 */
export function categoryLines(printed: string): string {
  return printed.split("\n").filter((line) => line.includes("Categories:")).join("\n");
}
