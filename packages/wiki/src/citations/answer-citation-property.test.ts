/**
 * The S7 invariant at corpus scale: one stack, many pages, and every page cited by
 * the identity the answer path mints for it resolves BACK TO THAT PAGE — not merely
 * to some page. The per-stem table in `answer-citation-targets.test.ts` builds one
 * page per case, which cannot catch a resolver that answers with a different
 * existing page when several are in play.
 *
 * The stems are chosen so every slug form is DISTINCT: a stack containing both
 * `7. Subdominios DDD` and `7-subdominios-ddd` has an ambiguous citation by
 * construction (pinned separately, with its exact-stem precedence rule), and an
 * identity assertion on an ambiguous target would be asserting a coin flip.
 *
 * Everything below drives the production chain — real page files on disk, then
 * `collectAnswerCitationIndex`, then `reportAnswerCitations`.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import os from "node:os";
import path from "node:path";
import { collectAnswerCitationIndex } from "./answer-index.js";
import { reportAnswerCitations } from "./answer-report.js";

/** Twelve concept stems covering slug-shaped, title-shaped, numeric and unicode names. */
const CONCEPT_STEMS = [
  "attention", "test2", "rbac-por-oficina", "raw-name-twelve", "2024 Recap",
  "7. Subdominios DDD", "東京 Café", "dotted.name", "Mixed-Case-KEY", "ünïcode-wörd",
  "a", "two words here",
];

/** Twelve query stems, disjoint from the concept names so precedence is never in play. */
const QUERY_STEMS = [
  "how-does-attention-work", "what-is-rbac", "explain-test2", "query-four", "Query Five",
  "6. Query Titled", "¿Qué es esto?", "sub.domain.query", "QUESTION-case", "ö-query",
  "q", "many words in a query",

];

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) await fs.rm(created.pop() as string, { recursive: true, force: true });
});

/** Write every stem of `stems` under `wiki/<directory>/` as a real page. */
async function writeDirectory(root: string, directory: string, stems: string[]): Promise<void> {
  for (const stem of stems) {
    const file = path.join(root, "wiki", directory, `${stem}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: "${stem}"\n---\n\nThe body of ${stem}.\n`);
  }
}

/** One temp stack holding every property page, freshly written. */
async function writeStack(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answer-citation-property-")));
  created.push(root);
  await writeDirectory(root, "concepts", CONCEPT_STEMS);
  await writeDirectory(root, "queries", QUERY_STEMS);
  return root;
}

describe("every page of a corpus resolves to itself", () => {
  it("retains the whole stack, then resolves each page cited by its own id", async () => {
    const root = await writeStack();
    const index = await collectAnswerCitationIndex(root);

    // Both directories are collected, so a missing half would weaken every assertion
    // below without failing them.
    expect(index.retained).toHaveLength(CONCEPT_STEMS.length + QUERY_STEMS.length);

    for (const entry of index.retained) {
      const report = await reportAnswerCitations(root, `Grounded in [[${entry.id}]].`);
      expect(report.citations, `citing ${entry.id}`).toMatchObject([
        { status: "resolved", pageId: entry.id },
      ]);
    }
  }, 60_000);

  it("resolves every page cited by a bare slug to the same identity", async () => {
    const root = await writeStack();
    const index = await collectAnswerCitationIndex(root);

    for (const entry of index.retained) {
      const report = await reportAnswerCitations(root, `Grounded in [[${entry.slug}]].`);
      expect(report.citations, `citing ${entry.slug}`).toMatchObject([
        { status: "resolved", pageId: entry.id },
      ]);
    }
  }, 60_000);
});
