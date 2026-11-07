/**
 * @file test/compiler/category-compile.test.ts
 * @description Category assignment measured at the PIPELINE level (S4, S10, S12).
 *
 * WHY THE COMPILE ENTRY POINT IS THE WHOLE POINT. A category file only exists in
 * `wiki/categories/` when a compile reached the assignment stage and wrote it
 * through the store. Calling the stage directly proves nothing about that, so every
 * case here drives `compileAndReport`; unwire the call site in `finalizeWiki` and
 * Y1, Y4, Y5 and Y6 all go red because no category file is ever written.
 *
 * WHAT EACH CASE PROTECTS.
 *  - Y1 a compile assigns an article to a category, and the file round-trips the
 *    four required attributes plus that member's reason and evidence key;
 *  - Y4 a concept and a category sharing "Sistemas distribuidos" stay TWO files with
 *    two identities through a real compile, and the concept page is byte-unchanged
 *    by the assignment;
 *  - Y5 the per-article bound truncates and is REPORTED by name in the run output;
 *  - Y6 a run that assigns nothing writes no category file and errors on nothing;
 *  - Y7 with no assignment the wiki is byte-identical to the run before it.
 *
 * The provider is stubbed, so no network, no key and no cost are involved.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../../src/compiler/index.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { stubCompileProvider } from "../fixtures/compile-provider.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";
import {
  ALMACENES_SOURCE,
  CATEGORY_CRITERION,
  CATEGORY_DESCRIPTION,
  CATEGORY_REASON,
  SISTEMAS_BODY,
  SISTEMAS_SOURCE,
  SISTEMAS_TITLE,
  bodyForArticle,
  categoryIds,
  extractionFor,
  proposal,
  proposalAnswer,
  readCategoryRecord,
  reviseSource,
  sistemasProposal,
  titleForSource,
  writeScenarioSources,
} from "../fixtures/category-scenario.js";

/** Route a category answer by the article the assignment prompt is about. */
function answerFor(sistemas?: Record<string, unknown>[], almacenes?: Record<string, unknown>[]) {
  return (system: string): string =>
    system.includes(`Article to categorise: "${SISTEMAS_TITLE}"`)
      ? proposalAnswer(...(sistemas ?? []))
      : proposalAnswer(...(almacenes ?? []));
}

/** Install the compile stub: extraction, page render, and the category answer. */
function stubProvider(categories: (system: string) => string): void {
  stubCompileProvider({
    extraction: (system) => extractionFor(titleForSource(system)),
    body: (system) => bodyForArticle(system),
    categories,
  });
}

/** The concept page's bytes for the article that shares its name with the category. */
async function conceptBytes(root: string): Promise<string> {
  return await readFile(path.join(root, "wiki", "concepts", "sistemas-distribuidos.md"), "utf-8");
}

describe("category assignment at the pipeline level", () => {
  const ctx = useCompileProject({ dirSuffix: "category-compile", sourceFile: SISTEMAS_SOURCE });

  it("Y1 a compile assigns the article and the file round-trips the four attributes", async () => {
    await writeScenarioSources(ctx.dir);
    stubProvider(answerFor([sistemasProposal()]));

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    const record = await readCategoryRecord(ctx.dir, "sistemas-distribuidos");
    expect(record.categoryId).toBe("sistemas-distribuidos");
    expect(record.canonicalName).toBe(SISTEMAS_TITLE);
    expect(record.description).toBe(CATEGORY_DESCRIPTION);
    expect(record.inclusionCriterion).toBe(CATEGORY_CRITERION);
    expect(record.members).toEqual([{
      pageId: "concepts/sistemas-distribuidos",
      reason: CATEGORY_REASON,
      evidenceKey: "consenso-distribuido",
    }]);
    expect(io.out()).toContain("Categories: 1 page(s) assigned to 1 category(ies) (1 new).");
    expect(io.err()).toBe("");
  });

  it("Y4 keeps the concept and the same-named category as two files", async () => {
    await writeScenarioSources(ctx.dir);
    // First compile: no category at all, so the concept page is written alone.
    stubProvider(answerFor());
    await compileAndReport(ctx.dir);
    const before = await conceptBytes(ctx.dir);

    // Second compile: ONLY the almacenes source moves, so the sistemas concept page
    // is not regenerated and any change to it could only come from the assignment.
    await reviseSource(ctx.dir, ALMACENES_SOURCE);
    stubProvider(answerFor([], [proposal({
      name: SISTEMAS_TITLE,
      description: CATEGORY_DESCRIPTION,
      criterion: 'Páginas que mencionen "embeddings".',
      reason: "El artículo guarda embeddings para búsqueda semántica.",
    })]));
    await compileAndReport(ctx.dir);

    expect(await conceptBytes(ctx.dir)).toBe(before);
    const concept = await readFile(path.join(ctx.dir, "wiki/concepts/sistemas-distribuidos.md"), "utf-8");
    const category = await readCategoryRecord(ctx.dir, "sistemas-distribuidos");
    expect(concept).toContain(`title: ${SISTEMAS_TITLE}`);
    expect(concept).not.toContain("categoryId:");
    expect(category.members.map((member) => member.pageId)).toEqual(["concepts/almacenes-de-vectores"]);
    expect(await categoryIds(ctx.dir)).toEqual(["sistemas-distribuidos"]);
  });

  it("Y5 truncates at the per-article bound and reports it by reason", async () => {
    await writeScenarioSources(ctx.dir);
    const many = ["consenso distribuido", "replicación", "nodos", "tolerancia a fallos", "teorema CAP"]
      .map((term, index) => proposal({
        name: `Categoría ${index}`,
        criterion: `Páginas que mencionen "${term}".`,
        reason: `El artículo menciona ${term}.`,
      }));
    stubProvider(answerFor(many));

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    expect(await categoryIds(ctx.dir)).toHaveLength(3);
    expect(io.out()).toContain("assigned to 3 category(ies)");
    expect(io.out()).toContain("truncated 2 article-cap");
    expect(SISTEMAS_BODY).toContain("teorema CAP");
  });

  it("Y6 writes no category file when the run assigns nothing", async () => {
    await writeScenarioSources(ctx.dir);
    stubProvider(answerFor());

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    expect(await categoryIds(ctx.dir)).toEqual([]);
    expect(io.out()).not.toContain("Categories:");
    expect(io.err()).toBe("");
  });

  it("Y7 leaves the whole wiki byte-identical when nothing is assigned", async () => {
    await writeScenarioSources(ctx.dir);
    stubProvider(answerFor());
    await compileAndReport(ctx.dir);
    const before = await fingerprintTree(path.join(ctx.dir, "wiki"));

    const io = captureProcessIo();
    await compileAndReport(ctx.dir);

    expect(changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki")))).toEqual([]);
    expect(io.out()).not.toContain("Categories:");
  });
});
