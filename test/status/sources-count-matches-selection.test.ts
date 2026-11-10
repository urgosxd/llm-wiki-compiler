/**
 * @file test/status/sources-count-matches-selection.test.ts
 * @description `status.sources` and `listSources()` must answer ONE question — how
 * many sources this project has — and the only way to prove that is to measure them
 * where the two corpora SEPARATE.
 *
 * ## Why the earlier test could not catch this
 *
 * `sources-count-matches-listing.test.ts` drives status through `withSourceDocuments`,
 * so `status.sources` counted `wiki.source_documents` rows while `listSources()` read
 * the selected `sources/` listing. Both were measured only after a successful
 * projection — the single moment when rows and files coincide — so the test passed
 * while the counters disagreed everywhere else. Measured on a fresh Stack: a hidden
 * dot-file gave `1 / 2`, `sources.exclude` gave `1 / 0`, and a row whose projected
 * file had been deleted gave `1 / 0`; the last two had AGREED at baseline, so the
 * row-counting fix regressed them.
 *
 * ## What is pinned, and where
 *
 * The invariant — `status.sources === listSources().sources.length` — under the
 * selection rules that make a row and a file disagree:
 *
 *   1. a hidden dot-file, which IS a source (`scan.ts` keeps dot-files);
 *   2. a row whose projected file was deleted, which is NOT a source;
 *   3. a source excluded by the Stack's `sources.exclude`;
 *   4. one ingested, uncompiled source, which must stay 1 and 1.
 *
 * Every case reads through the public facade (`createWiki` → `status()` /
 * `listSources()`), so the row seams `status()` supplies are the ones an embedder
 * gets, and no count is ever compared against a hand-rolled listing.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { Wiki } from "../../packages/wiki/src/sdk/types.js";
import type { WikiStatus } from "../../packages/wiki/src/status/collect.js";
import type { SourceRecord } from "../../packages/wiki/src/sources/store.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** Source text long enough to clear the minimum content an ingest enforces. */
function bodyFor(title: string): string {
  return `# ${title}\n\n${title} carries enough readable text to be ingested as a source.\n`;
}

/** The status the published SDK types as `unknown`; this suite needs the real shape. */
async function statusOf(wiki: Wiki): Promise<WikiStatus> {
  return (await wiki.status()) as WikiStatus;
}

/** The sources a handle lists for its own corpus. */
async function sourcesOf(wiki: Wiki): Promise<SourceRecord[]> {
  return ((await wiki.listSources()) as { sources: SourceRecord[] }).sources;
}

/** The two numbers under test, read the way an embedder reads them. */
async function agreement(root: string): Promise<{ listed: number; reported: number }> {
  const wiki = createWiki({ root });
  const status = await statusOf(wiki);
  return { listed: (await sourcesOf(wiki)).length, reported: status.sources };
}

/** Names currently projected under `sources/`, empty when the tree is absent. */
async function projectedSources(root: string): Promise<string[]> {
  try {
    return await readdir(path.join(root, "sources"));
  } catch {
    return [];
  }
}

/** Ingest one source through the facade, so the row AND its projected file exist. */
async function ingestOne(root: string): Promise<void> {
  await createWiki({ root }).ingestText({ title: "Alpha", text: bodyFor("Alpha") });
}

/** The one file `ingestOne` projected — the source the cases below take away. */
async function singleProjectedSource(root: string): Promise<string> {
  const names = await projectedSources(root);
  expect(names).toHaveLength(1);
  return names[0] as string;
}

/**
 * Run `body` with a freshly provisioned Stack, a temp project root, and their teardown.
 *
 * `useStackEnv` installs a Stack but keeps its database handle private, and the
 * excluded case has to WRITE `wiki.project_config`: no writer for that row exists in
 * `src/` today, so the row is stated directly, exactly as
 * `test/fixtures/request-stack.ts` does for a review policy. Environment restore and
 * teardown mirror `withStackEnv` and `withProjectRoot`, so a failure here can neither
 * leak a Stack into the next test nor leave a directory behind.
 *
 * @param label - Prefix for the temp root, so a failure names its case.
 * @param body - Receives the temp root and the Stack handle.
 */
async function withSelectionRoot(
  label: string,
  body: (root: string, harness: KgPostgresHarness) => Promise<void>,
): Promise<void> {
  const probe = await createProbeStack("status-sources-selection");
  const saved = { ...process.env };
  Object.assign(process.env, probe.env());
  const root = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await body(root, probe.harness);
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
    await probe.harness.cleanup();
  }
}

/** State `sources.exclude` for this Stack, the way the config reader reads it. */
async function excludeSources(harness: KgPostgresHarness, exclude: string[]): Promise<void> {
  const document = JSON.stringify({ version: 1, sources: { exclude } });
  await harness.db.execute(sql`
    insert into wiki.project_config (stack_id, document, version)
    values (${harness.stackId}, ${document}::jsonb, 1)
    on conflict (stack_id) do update set document = excluded.document, version = excluded.version
  `);
}

describe("status.sources follows the selected source listing", () => {
  it("reports the one ingested source the listing counts", async () => {
    await withSelectionRoot("selection-plain", async (root) => {
      await ingestOne(root);
      const { listed, reported } = await agreement(root);
      expect(listed).toBe(1);
      expect(reported).toBe(listed);
    });
  }, 120_000);

  it("counts a hidden dot-file that the listing counts", async () => {
    await withSelectionRoot("selection-dot", async (root) => {
      await ingestOne(root);
      await writeFile(path.join(root, "sources", ".hidden.md"), bodyFor("Hidden"));
      const { listed, reported } = await agreement(root);
      // Dot-files are sources: the listing counts 2, so the status must too.
      expect(listed).toBe(2);
      expect(reported).toBe(listed);
    });
  }, 120_000);

  it("does not count a row whose projected file was deleted", async () => {
    await withSelectionRoot("selection-deleted", async (root) => {
      await ingestOne(root);
      await unlink(path.join(root, "sources", await singleProjectedSource(root)));
      const { listed, reported } = await agreement(root);
      // The row survives the deletion; the source record does not. A count that
      // includes it names a source the caller can neither list nor read.
      expect(listed).toBe(0);
      expect(reported).toBe(listed);
    });
  }, 120_000);

  it("does not count a source the Stack config excludes", async () => {
    await withSelectionRoot("selection-excluded", async (root, harness) => {
      await ingestOne(root);
      // Ingest writes the file regardless of selection; `sources.exclude` decides
      // what the corpus IS, so the listing drops it and the count must follow.
      await excludeSources(harness, [await singleProjectedSource(root)]);
      const { listed, reported } = await agreement(root);
      expect(listed).toBe(0);
      expect(reported).toBe(listed);
    });
  }, 120_000);
});
