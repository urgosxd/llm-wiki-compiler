/**
 * @file test/compile-concept-identity.test.ts
 * @description End-to-end: a synonym pair extracted from one compile produces ONE
 * page, and the job's progress denominator counts that same page set.
 *
 * WHY THIS EXISTS
 *
 * The concept-identity resolver had no production caller, so `"Vector DB"` and
 * `"Vector Database"` compiled into two pages describing one thing. Wiring it in
 * has two halves that can each fail silently on its own:
 *
 *   1. The merge must see the canonical names. Grouping only inside
 *      `mergeExtractions` would leave source-state ownership on the alias slug, so
 *      the next compile would schedule the wrong owners.
 *   2. The denominator must be the SAME list the generation phase walks. Counting
 *      with a second, independently computed merge is how a progress bar reports N
 *      pages for a run that writes fewer.
 *
 * These tests drive the real pipeline and assert both, plus the fact that a page
 * left behind under the alias name is retired rather than left to split the concept.
 */
import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import type { JobProgress } from "../packages/wiki/src/services/ingest/jobs/types.js";
import { parseFrontmatter } from "../packages/wiki/src/utils/markdown.js";
import { readState } from "../packages/wiki/src/utils/state.js";
import { mockReconciliationProvider, useReconciliationProject } from "./fixtures/reconciliation-project.js";

const ctx = useReconciliationProject({
  dirSuffix: "concept-identity",
  sourceFile: "vectors.md",
  sourceContent: "# Vectors\n\nA source naming one subject two ways.",
});

/**
 * Synonyms the deterministic tiers fold without any embedding call.
 *
 * Equal confidence, so the canonical name is decided by the lexicographic
 * tie-break: "Vector DB" sorts before "Vector Database" and wins. The test asserts
 * that outcome instead of whichever one happens to look nicer, because the
 * tie-break being deterministic and not arrival-ordered is the property that
 * matters for reproducible page slugs.
 */
const SYNONYMS = ["Vector DB", "Vector Database"];

/** Slug the group is published under. */
const CANONICAL_SLUG = "vector-db";

/** Slug of the name that folded into it. */
const ALIAS_SLUG = "vector-database";

/**
 * Answer extraction with the two synonym names, both claiming to be new.
 *
 * @returns The provider stub, with both model calls mocked.
 */
function synonymProvider() {
  const provider = mockReconciliationProvider();
  provider.toolCall.mockImplementation(async () =>
    JSON.stringify({
      concepts: SYNONYMS.map((concept) => ({
        concept,
        summary: "An approximate nearest-neighbour index.",
        is_new: true,
        confidence: 0.9,
      })),
    }),
  );
  provider.complete.mockResolvedValue("Supported content about vector databases.");
  return provider;
}

/**
 * Put a pre-existing concept page on disk, as a wiki compiled before this feature
 * would have it.
 *
 * @param root - Project root.
 * @param slug - Page slug and filename stem.
 * @param title - Frontmatter title.
 */
async function seedPage(root: string, slug: string, title: string): Promise<void> {
  const file = path.join(root, "wiki", "concepts", `${slug}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\ntitle: ${title}\nsummary: existing\n---\n\nExisting body.\n`, "utf-8");
}

/** Every page filename present under `wiki/concepts`. */
async function conceptPages(root: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(path.join(root, "wiki", "concepts"));
    return files.filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

/** Collect the progress pairs the compile publishes, ignoring stage resets. */
function recordingObserver(seen: JobProgress[]) {
  return {
    ingest: { stage: () => undefined },
    attempts: { attemptStarted: () => undefined, attemptSettled: () => undefined },
    compile: {
      stage: () => undefined,
      progress: (value: JobProgress | null) => {
        if (value !== null) seen.push(value);
      },
      detail: () => undefined,
    },
  };
}

describe("concept identity on the compile path", () => {
  it("writes ONE page for a synonym pair instead of two", async () => {
    synonymProvider();

    await compileAndReport(ctx.dir);

    expect(await conceptPages(ctx.dir)).toEqual([`${CANONICAL_SLUG}.md`]);
  });

  it("publishes a denominator equal to the pages it generates", async () => {
    synonymProvider();
    const seen: JobProgress[] = [];

    await compileAndReport(ctx.dir, { jobObserver: recordingObserver(seen) });

    const generationTotals = [...new Set(seen.map((entry) => entry.total))];
    expect(generationTotals).toContain(1);
    expect(generationTotals).not.toContain(SYNONYMS.length);
  });

  it("records ownership under the canonical slug, not the alias", async () => {
    synonymProvider();

    await compileAndReport(ctx.dir);
    const state = await readState(ctx.dir);

    // Both names became the one canonical slug. Two entries, one identity: source
    // state records one slug per extracted concept, and both concepts are now the
    // same concept.
    expect(new Set(state.sources["vectors.md"]?.concepts)).toEqual(new Set([CANONICAL_SLUG]));
  });

  it("retires the alias page when both names already had a page of their own", async () => {
    // The state a wiki is in when this feature meets it: two pages, one concept.
    // Both slugs are incumbents, so the canonical slot goes to the name the
    // incumbent rule orders first and the OTHER page has no producer left.
    await seedPage(ctx.dir, ALIAS_SLUG, "Vector Database");
    await seedPage(ctx.dir, CANONICAL_SLUG, "Vector DB");
    synonymProvider();

    await compileAndReport(ctx.dir);

    const retired = parseFrontmatter(
      await readFile(path.join(ctx.dir, "wiki", "concepts", `${ALIAS_SLUG}.md`), "utf-8"),
    );
    expect(retired.meta.orphaned).toBe(true);
    expect((await conceptPages(ctx.dir)).length).toBe(2);
  });

  it("keeps the incumbent page's slug and folds the newcomer into it", async () => {
    // One page exists; the tie-break would prefer the OTHER name. Incumbency must
    // still win, or the page moves and every inbound link to it breaks.
    await seedPage(ctx.dir, ALIAS_SLUG, "Vector Database");
    synonymProvider();

    await compileAndReport(ctx.dir);

    const kept = parseFrontmatter(
      await readFile(path.join(ctx.dir, "wiki", "concepts", `${ALIAS_SLUG}.md`), "utf-8"),
    );
    expect(kept.meta.orphaned).toBeUndefined();
  });

  it("folds both names into one page while keeping them as separate source claims", async () => {
    synonymProvider();

    await compileAndReport(ctx.dir);
    const state = await readState(ctx.dir);

    // One page, and the source still records one claim per extracted concept. The
    // ownership list is the by-concept slug list, so both claims point at the one
    // canonical slug -- which is what makes the next compile schedule this source
    // as an owner of the canonical page rather than of a page nobody writes.
    expect(await conceptPages(ctx.dir)).toEqual([`${CANONICAL_SLUG}.md`]);
    expect(state.sources["vectors.md"]?.concepts).toHaveLength(SYNONYMS.length);
  });
});
