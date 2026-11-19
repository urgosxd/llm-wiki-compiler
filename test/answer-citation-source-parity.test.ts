/**
 * @file One page corpus, two sources: the citation verdicts must not depend on which.
 *
 * ## What this file is for, and what it is not
 *
 * T2 made the citation index read through the page-source seam, so a row-backed Stack
 * resolves its answer citations instead of walking a `wiki/` directory it does not have.
 * That fix is only correct if the FILE path still answers exactly as it did, and if the
 * two sources answer the same for the same content — spec S8's differential. This file
 * materializes ONE fixture twice (real `.md` files with frontmatter, and `wiki.pages`
 * rows) and compares the reports.
 *
 * It adds no production code. A differential is a preservation pin: it is expected to
 * pass, and if it does not, the difference IS the second bug and gets explained, never
 * smoothed over by changing an expectation.
 *
 * ## Why the file half names its authority instead of relying on the environment
 *
 * The runner seeds a database URL into every worker, and the authority resolver refuses
 * a configured database with no named Stack. So the file half passes
 * `{ kind: "file", reason: "no-database-configured" }` explicitly: the seam branches on
 * the authority it is given, which is the same explicit decision a file-backed
 * deployment makes ({@link StackAuthority}). Nothing here switches the process's
 * environment, so the row half keeps the database it needs.
 *
 * ## Why an unreachable harness FAILS rather than skips
 *
 * `withRowsStack` returns silently without a database (`test/fixtures/rows-only-stack.ts:54`),
 * and a differential that compares nothing is this campaign's bug class in test form. The
 * {@link requireDatabase} assertion states that the proof is void instead.
 *
 * ## Why non-vacuity is asserted, not assumed
 *
 * Two empty reports are equal, and two all-broken reports are equal: both "pass" the
 * comparison while proving nothing. So the fixture carries pages that exist and one that
 * does not, the exact verdicts are pinned, and the statuses are required to span resolved
 * AND broken before the comparison is trusted.
 */
import { afterAll, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKgPostgresHarness, DATABASE_URL } from "./fixtures/kg-postgres.js";
import { upsertStoredPage } from "../packages/wiki/src/dimensions/wiki/page-store.js";
import { withRawPageSource } from "../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import type { StackAuthority } from "../packages/wiki/src/dimensions/stack-authority.js";
import { reportAnswerCitations } from "../packages/wiki/src/citations/answer-report.js";
import type { AnswerCitationReport } from "../packages/wiki/src/citations/answer-types.js";
import type { PageDirectory } from "../packages/wiki/src/export/types.js";

/** One page as BOTH sources must carry it: identity, text, and declared aliases. */
interface FixturePage {
  readonly pageDirectory: PageDirectory;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly aliases: readonly string[];
}

/** Several pages across BOTH wiki directories, one of them carrying frontmatter aliases. */
const PAGES: readonly FixturePage[] = [
  { pageDirectory: "concepts", slug: "alpha", title: "Alpha", summary: "About alpha.", aliases: [] },
  { pageDirectory: "concepts", slug: "vector-db", title: "Vector DB", summary: "About vectors.", aliases: ["Vector Database"] },
  { pageDirectory: "queries", slug: "beta", title: "Beta", summary: "About beta.", aliases: [] },
];

/** The answer classified below: every fixture page, the alias, and one target neither source has. */
const ANSWER = "Grounded in [[Alpha]], [[Vector Database]], [[beta]] and in [[Gone]].";

/** How the report must read when BOTH sources hold {@link PAGES} and nothing else exists. */
const EXPECTED = [
  { target: "alpha", status: "resolved", pageId: "concepts/alpha" },
  { target: "vector-database", status: "resolved", pageId: "concepts/vector-db" },
  { target: "beta", status: "resolved", pageId: "queries/beta" },
  { target: "gone", status: "broken" },
];

const harness = await createKgPostgresHarness("answer-citation-source-parity");
const diskRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "citation-parity-disk-")));
const rowRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "citation-parity-rows-")));

afterAll(async () => {
  await rm(diskRoot, { recursive: true, force: true });
  await rm(rowRoot, { recursive: true, force: true });
  await harness.cleanup();
});

/** The environment naming this suite's Stack and the database that holds it. */
const ENV = { AKS_STACK_ID: harness.stackId, AKS_DATABASE_URL: DATABASE_URL };
/** The authority a deployment with no database at all resolves. */
const FILE_AUTHORITY: StackAuthority = { kind: "file", reason: "no-database-configured" };
/** The authority this suite's Stack resolves. */
const STACK_AUTHORITY: StackAuthority = { kind: "stack", stackId: harness.stackId };

/** Refuse to compare against rows a database never held. */
function requireDatabase(): void {
  expect(harness.reachable, "no database reached this worker: the disk-versus-row differential is void").toBe(true);
}

/** The page as a file backend stores it: frontmatter the production parser reads. */
function pageMarkdown(page: FixturePage): string {
  const aliases = page.aliases.length > 0 ? `aliases: [${page.aliases.join(", ")}]\n` : "";
  return `---\ntitle: ${page.title}\nsummary: ${page.summary}\n${aliases}---\n\n${page.slug} body.\n`;
}

/** Materialize the fixture as real `.md` files under a temp root's compiled wiki directories. */
async function materializeFiles(): Promise<void> {
  for (const page of PAGES) {
    const dir = path.join(diskRoot, "wiki", page.pageDirectory);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${page.slug}.md`), pageMarkdown(page));
  }
}

/** Materialize the SAME fixture as `wiki.pages` rows; `rowRoot` gets no wiki content. */
async function materializeRows(): Promise<void> {
  for (const page of PAGES) {
    await upsertStoredPage(harness.db, harness.stackId, {
      pageDirectory: page.pageDirectory, slug: page.slug, title: page.title,
      summary: page.summary, aliases: [...page.aliases],
      tags: [], links: [], orphaned: false, archived: false, body: `${page.slug} body.`,
    });
  }
}

/** Report {@link ANSWER} through the production seam in the mode the authority names. */
async function reportFrom(root: string, authority: StackAuthority): Promise<AnswerCitationReport> {
  return await withRawPageSource(root, ENV, (source) => reportAnswerCitations(root, ANSWER, source), authority);
}

it("produces the same citation verdicts from disk and from rows", async () => {
  requireDatabase();
  await materializeFiles();
  await materializeRows();
  // The row half cannot be answered from disk: its root has no wiki content at all.
  await expect(readdir(path.join(rowRoot, "wiki"))).rejects.toMatchObject({ code: "ENOENT" });
  const fromDisk = await reportFrom(diskRoot, FILE_AUTHORITY);
  const fromRows = await reportFrom(rowRoot, STACK_AUTHORITY);
  // NON-VACUOUS: two empty reports, or two all-broken ones, would agree trivially.
  expect(fromDisk.citations.length).toBeGreaterThan(0);
  expect(fromDisk.citations.map((citation) => citation.status)).toContain("resolved");
  expect(fromDisk.citations.map((citation) => citation.status)).toContain("broken");
  // Both halves are right, and therefore equal — the differential S8 asks for.
  expect(fromDisk.citations).toEqual(EXPECTED);
  expect(fromRows).toEqual(fromDisk);
});

it("resolves the alias citation to the same page on both sources", async () => {
  requireDatabase();
  await materializeFiles();
  await materializeRows();
  const target = "vector-database";
  // The one place the sources could genuinely diverge: a row carries its aliases in
  // `frontmatter.aliases`, and the disk walk parses the same field out of the file.
  const find = (report: AnswerCitationReport) => report.citations.find((citation) => citation.target === target);
  const fromDisk = find(await reportFrom(diskRoot, FILE_AUTHORITY));
  expect(fromDisk).toEqual({ target, status: "resolved", pageId: "concepts/vector-db" });
  expect(find(await reportFrom(rowRoot, STACK_AUTHORITY))).toEqual(fromDisk);
});
