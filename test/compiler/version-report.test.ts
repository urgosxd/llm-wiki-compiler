/**
 * @file test/compiler/version-report.test.ts
 * @description Z1 and Z3: the synthesis-version split of a wiki is REPORTED on every
 * compile run, and a compile that changes nothing still says it and still writes nothing.
 *
 * WHY THIS EXISTS. `promptVersion` is stamped into every page's frontmatter
 * (`addModelProvenanceMeta`) and read by nothing that could compare it to the current
 * version, so a prompt bump silently left a corpus holding two prompt generations at
 * once with no surface saying so. The measurement was taken in `wiki-stability.test.ts`
 * (S-A4); this file pins the cure: one line, on a normal run, naming both counts and
 * both versions — or naming the single version plainly, because a line that appears
 * only sometimes is indistinguishable from a broken one.
 *
 * The unit cases pin the exact wording, so a wording change is a decision rather than a
 * diff nobody read. The compile-level cases drive `compileAndReport`, which is where the
 * operator actually reads it.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { PROMPT_VERSION } from "../../packages/wiki/src/compiler/prompts.js";
import {
  describeVersionSplit,
  summarizeVersions,
  type PageVersionRecord,
} from "../../packages/wiki/src/compiler/version-report.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { fingerprintTree, changedPaths } from "../fixtures/tree-fingerprint.js";
import { writePage } from "../fixtures/write-page.js";

/** Records for a wiki whose pages are split across the given versions. */
function records(...versions: (string | null)[]): PageVersionRecord[] {
  return versions.map((promptVersion, index) => ({
    pageId: `concepts/page-${index}`,
    promptVersion,
  }));
}

/** Write one concept page carrying an optional recorded synthesis version. */
async function writeVersionedPage(
  root: string,
  slug: string,
  title: string,
  promptVersion?: string,
): Promise<void> {
  const fields: Record<string, unknown> = {
    title,
    summary: `Summary of ${title}.`,
    kind: "concept",
    ...(promptVersion === undefined ? {} : { promptVersion }),
  };
  await writePage(path.join(root, "wiki/concepts"), slug, fields, `${title} body.`);
}

/** A project root with an empty `sources/` directory, so a compile has nothing to do. */
async function prepareQuietProject(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
}

describe("describeVersionSplit — wording", () => {
  it("names both counts and both versions when the wiki holds two of them", () => {
    const split = summarizeVersions(records("v1", "v1", "v1", PROMPT_VERSION, PROMPT_VERSION), PROMPT_VERSION);
    expect(describeVersionSplit(split)).toBe(
      `Synthesis version split: 3 page(s) compiled at v1, 2 page(s) compiled at ${PROMPT_VERSION} ` +
        "(the current version).",
    );
  });

  it("prints plainly when every page shares the current version", () => {
    const split = summarizeVersions(records(PROMPT_VERSION, PROMPT_VERSION), PROMPT_VERSION);
    expect(describeVersionSplit(split)).toBe(
      `Synthesis version: 2 page(s) compiled at ${PROMPT_VERSION} (the current version).`,
    );
  });

  it("prints plainly and names the current version when every page is stale", () => {
    const split = summarizeVersions(records("v1", "v1"), PROMPT_VERSION);
    expect(describeVersionSplit(split)).toBe(
      `Synthesis version: 2 page(s) compiled at v1 (the current version is ${PROMPT_VERSION}).`,
    );
  });

  it("counts pages with no recorded version instead of hiding them", () => {
    const split = summarizeVersions(records(PROMPT_VERSION, null), PROMPT_VERSION);
    expect(split.unversioned).toBe(1);
    expect(split.stalePages).toBe(1);
    expect(describeVersionSplit(split)).toBe(
      `Synthesis version: 1 page(s) compiled at ${PROMPT_VERSION} (the current version), ` +
        "1 page(s) with no recorded version.",
    );
  });

  it("says so, rather than nothing, when the wiki stores no pages", () => {
    const split = summarizeVersions([], PROMPT_VERSION);
    expect(describeVersionSplit(split)).toBe(
      `Synthesis version: no pages stored yet (the current version is ${PROMPT_VERSION}).`,
    );
  });
});

describe("the version line on a compile run", () => {
  const ctx = useTempRoot();

  it("Z1 reports two versions on a run that compiles nothing", async () => {
    await prepareQuietProject(ctx.dir);
    await writeVersionedPage(ctx.dir, "alpha-topic", "Alpha Topic", "v1");
    await writeVersionedPage(ctx.dir, "beta-topic", "Beta Topic", PROMPT_VERSION);
    const io = captureProcessIo();
    const result = await compileAndReport(ctx.dir, { embeddings: false });

    expect(result.errors).toEqual([]);
    expect(io.err()).toBe("");
    expect(io.out()).toContain(
      `Synthesis version split: 1 page(s) compiled at v1, 1 page(s) compiled at ${PROMPT_VERSION} ` +
        "(the current version)",
    );
  });

  it("Z1 reports one version plainly when every page shares it", async () => {
    await prepareQuietProject(ctx.dir);
    await writeVersionedPage(ctx.dir, "alpha-topic", "Alpha Topic", PROMPT_VERSION);
    const io = captureProcessIo();
    await compileAndReport(ctx.dir, { embeddings: false });

    expect(io.out()).toContain(
      `Synthesis version: 1 page(s) compiled at ${PROMPT_VERSION} (the current version).`,
    );
    expect(io.out()).not.toContain("Synthesis version split:");
  });

  it("Z3 a compile that changes nothing still prints the line and writes nothing", async () => {
    await prepareQuietProject(ctx.dir);
    await writeVersionedPage(ctx.dir, "alpha-topic", "Alpha Topic", "v1");
    // The FIRST run of a wiki legitimately writes its index and MOC, so the settled
    // state is taken after it: "changes nothing" is a claim about a wiki that already has
    // everything a compile would produce.
    await compileAndReport(ctx.dir, { embeddings: false });
    const before = await fingerprintTree(path.join(ctx.dir, "wiki"));
    const io = captureProcessIo();
    await compileAndReport(ctx.dir, { embeddings: false });

    expect(io.out()).toContain("Nothing to compile — all sources up to date.");
    expect(io.out()).toContain("Synthesis version:");
    expect(changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki")))).toEqual([]);
  });
});
