/**
 * @file test/compiler/link-review-compile.test.ts
 * @description Pin the whole-wiki cost of the review stage at the pipeline level:
 * an ingest that changes one article must leave every other page byte-identical,
 * and a compile with nothing to do must write no page at all (S9, S12).
 *
 * Driven through `compileAndReport`, the public compile entry point, so the proof
 * covers whatever the pipeline wires around the stage rather than the stage alone.
 * The provider is stubbed, so no network and no key are involved.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { compileAndReport } from "../../src/compiler/index.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";
import { captureProcessIo } from "../fixtures/process-io.js";

/** The source the first compile creates, and the second recompiles. */
const ALPHA_SOURCE = "alpha.md";

/** Extraction payload naming one concept. */
function extractionFor(title: string): string {
  return JSON.stringify({ concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }] });
}

/**
 * Stub the provider for both structured calls the pipeline makes: extraction (the
 * page's own title) and the reference review, which always refuses here so that no
 * link is ever added by this file's runs.
 */
function stubProvider(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (system: string, _messages, tools) => {
      if (tools[0]?.name === "judge_reference") {
        return JSON.stringify({ should_link: false, mention: "" });
      }
      // Route on the SOURCE TEXT, not on a title: the extraction prompt also carries
      // the existing wiki index, which contains every title already compiled.
      return extractionFor(system.includes("About beta.") ? "Beta Topic" : "Alpha Topic");
    },
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("A body of prose. ^[alpha.md]");
}

/** Write the source corpus of a two-concept project. */
async function writeSources(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", ALPHA_SOURCE), "# Alpha Topic\n\nAbout alpha.\n", "utf-8");
  await writeFile(path.join(root, "sources", "beta.md"), "# Beta Topic\n\nAbout beta.\n", "utf-8");
}

describe("link review at the pipeline level", () => {
  const ctx = useCompileProject({ dirSuffix: "link-review-compile", sourceFile: ALPHA_SOURCE });

  it("V8 writes no page at all when a compile finds nothing to do", async () => {
    await writeSources(ctx.dir);
    stubProvider();
    await compileAndReport(ctx.dir);
    const before = await fingerprintTree(path.join(ctx.dir, "wiki/concepts"));
    expect(before.size).toBeGreaterThan(0);

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    expect(changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki/concepts")))).toEqual([]);
    expect(io.out()).not.toContain("Link review");
  });

  it("leaves an earlier page byte-identical when a different article is recompiled", async () => {
    await writeSources(ctx.dir);
    stubProvider();
    await compileAndReport(ctx.dir);
    const earlier = await readFile(path.join(ctx.dir, "wiki/concepts/beta-topic.md"), "utf-8");

    await writeFile(
      path.join(ctx.dir, "sources", ALPHA_SOURCE),
      "# Alpha Topic\n\nAbout alpha, revised.\n",
      "utf-8",
    );
    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    expect(await readFile(path.join(ctx.dir, "wiki/concepts/beta-topic.md"), "utf-8")).toBe(earlier);
    expect(io.out()).not.toContain("Link review");
  });
});
