/**
 * @file test/compiler/version-recompile.test.ts
 * @description Z2 and Z7 (the lever): `llmwiki compile --recompile <page>` regenerates
 * exactly the named page at the CURRENT synthesis version and leaves every other page
 * byte-identical, and an unusable request is refused with an exit code instead of a
 * silent no-op.
 *
 * WHY THE LEVER IS TESTED AS A LEVER. The version line alone is a dashboard nobody can
 * act on: `promptVersion` is recorded per page and nothing compares it to the current
 * one, so a bumped prompt leaves stale pages that only a source edit could refresh. The
 * lever is the actionable half of that rule, and it is the half that can DAMAGE a wiki:
 * a scoped run re-extracts whole sources, so without the page filter its SIBLING pages
 * would be rewritten too, and without retained ownership those siblings would be left
 * with no recorded owner for the next compile to read as orphaned. Both are asserted.
 *
 * Driven through the public entry points: `compileRecompiling` (root-scoped) for the
 * regeneration itself, and `compileCommand` (cwd-scoped) for the exit code an operator
 * sees. The provider is stubbed, so no network and no key are involved.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import compileCommand from "../../src/commands/compile.js";
import { compileAndReport, compileRecompiling } from "../../src/compiler/index.js";
import { PROMPT_VERSION } from "../../src/compiler/prompts.js";
import { buildFrontmatter, parseFrontmatter } from "../../src/utils/markdown.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { stubCompileProvider } from "../fixtures/compile-provider.js";
import { readConceptPage } from "../fixtures/concept-page.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";
import { captureProcessIo, type CapturedProcessIo } from "../fixtures/process-io.js";

/** Marker that routes the extraction stub to the beta source. */
const BETA_MARKER = "BETA SOURCE TEXT";

/** Alpha owns one page; beta owns TWO, so beta has a sibling that must not be touched. */
const ALPHA_SOURCE = "# Alpha Topic\n\nAlpha prose about alpha.\n";
const BETA_SOURCE = `# Beta Topic\n\n${BETA_MARKER}. Beta prose.\n`;

/** Answers for the three provider calls a compile makes, routed on the prompt text. */
function stubProvider(): void {
  stubCompileProvider({
    extraction: (system) =>
      JSON.stringify({
        concepts: system.includes(BETA_MARKER)
          ? [{ concept: "Beta Topic", summary: "Summary.", is_new: true },
             { concept: "Gamma Topic", summary: "Summary.", is_new: true }]
          : [{ concept: "Alpha Topic", summary: "Summary.", is_new: true }],
      }),
    body: (system) => {
      const title = /Concept to write about: "([^"]+)"/.exec(system)?.[1] ?? "Alpha Topic";
      return `${title} body. ^[${title.split(" ")[0]!.toLowerCase()}.md]`;
    },
  });
}

/** Write both sources of the fixture. */
async function writeSources(root: string): Promise<void> {
  await writeFile(path.join(root, "sources", "alpha.md"), ALPHA_SOURCE, "utf-8");
  await writeFile(path.join(root, "sources", "beta.md"), BETA_SOURCE, "utf-8");
}

/** Rewrite one page's recorded synthesis version, as an older prompt would have left it. */
async function restampVersion(root: string, slug: string, version: string): Promise<void> {
  const page = await readConceptPage(root, slug);
  const { meta, body } = parseFrontmatter(page);
  await writeFile(
    path.join(root, "wiki/concepts", `${slug}.md`),
    `${buildFrontmatter({ ...meta, promptVersion: version })}\n\n${body}\n`,
    "utf-8",
  );
}

/** The concepts `state.json` records for one source file. */
async function recordedConcepts(root: string, source: string): Promise<string[]> {
  const state = JSON.parse(await readFile(path.join(root, ".llmwiki/state.json"), "utf-8"));
  return [...state.sources[source].concepts].sort();
}

/** Run `llmwiki compile --recompile` the way the CLI does: from the project root. */
async function runRecompileCommand(
  root: string,
  pages: readonly string[],
): Promise<{ code: number; io: CapturedProcessIo }> {
  const original = process.cwd();
  process.chdir(root);
  const io = captureProcessIo();
  try {
    return { code: await compileCommand({}, pages), io };
  } finally {
    process.chdir(original);
  }
}

describe("compile --recompile", () => {
  const ctx = useCompileProject({ dirSuffix: "version-recompile", sourceFile: "alpha.md" });

  it("Z2 regenerates exactly the named page, sibling pages untouched", async () => {
    stubProvider();
    await writeSources(ctx.dir);
    await compileAndReport(ctx.dir, { embeddings: false });
    await restampVersion(ctx.dir, "beta-topic", "v1");
    const before = await fingerprintTree(path.join(ctx.dir, "wiki/concepts"));
    const sibling = await readConceptPage(ctx.dir, "gamma-topic");

    const result = await compileRecompiling(ctx.dir, ["concepts/beta-topic"]);

    expect(result.errors).toEqual([]);
    expect(result.pages).toEqual(["beta-topic"]);
    expect(await readConceptPage(ctx.dir, "beta-topic")).toContain(`promptVersion: ${PROMPT_VERSION}`);
    expect(await readConceptPage(ctx.dir, "gamma-topic")).toBe(sibling);
    const changed = changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki/concepts")));
    expect(changed).toEqual(["beta-topic.md"]);
  });

  it("keeps every concept the re-extracted source produced owned", async () => {
    stubProvider();
    await writeSources(ctx.dir);
    await compileAndReport(ctx.dir, { embeddings: false });
    await restampVersion(ctx.dir, "beta-topic", "v1");
    await compileRecompiling(ctx.dir, ["concepts/beta-topic"]);

    expect(await recordedConcepts(ctx.dir, "beta.md")).toEqual(["beta-topic", "gamma-topic"]);
    // ...and the next ordinary compile reads gamma-topic as owned, not as an orphan.
    await compileAndReport(ctx.dir, { embeddings: false });
    expect(await readConceptPage(ctx.dir, "gamma-topic")).not.toContain("orphaned: true");
  });

  it("Z7 refuses a page the wiki does not store, and writes nothing", async () => {
    stubProvider();
    await writeSources(ctx.dir);
    await compileAndReport(ctx.dir, { embeddings: false });
    const before = await fingerprintTree(path.join(ctx.dir, "wiki"));

    const { code, io } = await runRecompileCommand(ctx.dir, ["concepts/missing"]);

    expect(code).toBe(1);
    expect(io.out()).toContain('Cannot recompile: no page named "concepts/missing" exists in this wiki.');
    expect(changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki")))).toEqual([]);
  });

  it("Z7 refuses every request on a wiki that stores no pages", async () => {
    stubProvider();
    const { code, io } = await runRecompileCommand(ctx.dir, ["all"]);
    expect(code).toBe(1);
    expect(io.out()).toContain("Cannot recompile: this wiki stores no pages yet (nothing to regenerate).");
  });

  it("Z7 `all` regenerates every stored page that a source owns", async () => {
    stubProvider();
    await writeSources(ctx.dir);
    await compileAndReport(ctx.dir, { embeddings: false });
    for (const slug of ["alpha-topic", "beta-topic", "gamma-topic"]) {
      await restampVersion(ctx.dir, slug, "v1");
    }

    const { code } = await runRecompileCommand(ctx.dir, ["all"]);

    expect(code).toBe(0);
    for (const slug of ["alpha-topic", "beta-topic", "gamma-topic"]) {
      expect(await readConceptPage(ctx.dir, slug)).toContain(`promptVersion: ${PROMPT_VERSION}`);
    }
  });

  it("keeps an ordinary compile working, version stamping included", async () => {
    stubProvider();
    await writeSources(ctx.dir);
    const result = await compileAndReport(ctx.dir, { embeddings: false });
    expect(result.errors).toEqual([]);
    expect(result.compiled).toBe(2);
    const alpha = await readFile(path.join(ctx.dir, "wiki/concepts/alpha-topic.md"), "utf-8");
    expect(alpha).toContain(`promptVersion: ${PROMPT_VERSION}`);
  });
});
