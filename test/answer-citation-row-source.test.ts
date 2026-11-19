/**
 * @file Row-backed answer-citation resolution, proven against a real database.
 *
 * ## Why this suite does not use `withRowsStack`
 *
 * That helper returns silently when the database is unreachable
 * (`test/fixtures/rows-only-stack.ts:54`), so a worker with no Postgres reports every
 * case as PASSED while asserting nothing. The behaviour this file pins is precisely the
 * one that went missing for a whole release — a row-backed Stack resolving nothing —
 * so an unreachable harness FAILS here instead: {@link requireDatabase} asserts
 * reachability with a message stating that the proof is void.
 *
 * ## What the tree looks like
 *
 * The project root is a real temporary directory with NO `wiki/` directory, so no case
 * in this file can pass by falling back to a disk scan: every page these assertions
 * resolve exists only as a `wiki.pages` row. That premise is asserted, not assumed.
 *
 * ## Why the whole array is compared
 *
 * A citation report is a snapshot of every recognized target in first-occurrence order.
 * Asserting only "resolved" passes when the index invents entries; asserting only
 * "broken" passes when the index is empty, which is the defect. Each case therefore
 * compares the FULL list, with a page that exists and a page that does not in ONE
 * answer body.
 */
import { afterAll, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKgPostgresHarness, DATABASE_URL } from "./fixtures/kg-postgres.js";
import { upsertStoredPage } from "../packages/wiki/src/dimensions/wiki/page-store.js";
import { withRawPageSource } from "../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import { collectAnswerCitationIndex } from "../packages/wiki/src/citations/answer-index.js";
import { reportAnswerCitations } from "../packages/wiki/src/citations/answer-report.js";
import { reportQueryAnswerCitations } from "../packages/wiki/src/commands/query-citation-report.js";
import type { Page } from "../packages/wiki/src/pages/list.js";

const harness = await createKgPostgresHarness("answer-citation-row-source");
const root = await mkdtemp(path.join(os.tmpdir(), "answer-citation-row-source-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
});

/** The environment naming this suite's Stack and the database that holds it. */
const ENV = { AKS_STACK_ID: harness.stackId, AKS_DATABASE_URL: DATABASE_URL };

/** A minimal stored page; its identity is the directory plus the slug. */
function pageOf(slug: string, overrides: Partial<Page> = {}): Page {
  return {
    slug,
    pageDirectory: "concepts",
    title: `Title ${slug}`,
    summary: `summary about ${slug}`,
    tags: [],
    links: [],
    orphaned: false,
    archived: false,
    body: `body ${slug}`,
    ...overrides,
  };
}

/**
 * Refuse to continue without a database: an unreachable harness proves nothing.
 *
 * Called at the TOP of every case, before any assertion, so a missing database is a
 * failure that says why instead of a green suite that returned early.
 */
function requireDatabase(): void {
  expect(harness.reachable, "no database reached this worker: the row-backed citation proof is void").toBe(true);
}

/** Report one answer body through the production seam, exactly as `query` does. */
async function report(body: string) {
  return await withRawPageSource(root, ENV, (source) => reportAnswerCitations(root, body, source));
}

it("resolves a row-backed page and reports only the absent one broken", async () => {
  requireDatabase();
  // The premise: no `wiki/` directory exists, so nothing here can resolve from disk.
  await expect(readdir(path.join(root, "wiki"))).rejects.toMatchObject({ code: "ENOENT" });
  await upsertStoredPage(harness.db, harness.stackId, pageOf("alpha"));
  expect(await report("Grounded in [[Alpha]] and in [[Gone]].")).toEqual({
    version: 1,
    citations: [
      { target: "alpha", status: "resolved", pageId: "concepts/alpha" },
      { target: "gone", status: "broken" },
    ],
  });
}, 30_000);

it("resolves a declared alias from rows, as the disk walk does", async () => {
  requireDatabase();
  await upsertStoredPage(harness.db, harness.stackId, pageOf("vector-db", { aliases: ["Vector Database"] }));
  expect((await report("Stored in [[Vector Database]].")).citations).toEqual([
    { target: "vector-database", status: "resolved", pageId: "concepts/vector-db" },
  ]);
}, 30_000);

it("reaches the same verdicts through the query diagnostic boundary", async () => {
  requireDatabase();
  await upsertStoredPage(harness.db, harness.stackId, pageOf("beta", { pageDirectory: "queries" }));
  const fields = await withRawPageSource(root, ENV, (source) => reportQueryAnswerCitations(root, "See [[beta]].", source));
  expect(fields.answerCitations?.citations).toEqual([
    { target: "beta", status: "resolved", pageId: "queries/beta" },
  ]);
}, 30_000);

it("returns a legitimately empty index for a readable Stack with no pages", async () => {
  requireDatabase();
  const empty = await createKgPostgresHarness("answer-citation-row-empty");
  try {
    expect(empty.reachable, "no database reached this worker: the empty-Stack proof is void").toBe(true);
    const index = await withRawPageSource(root, { ...ENV, AKS_STACK_ID: empty.stackId },
      (source) => collectAnswerCitationIndex(root, source));
    expect(index).toEqual({ retained: [], pending: [] });
  } finally {
    await empty.cleanup();
  }
}, 30_000);
