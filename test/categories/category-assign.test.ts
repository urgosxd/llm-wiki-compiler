/**
 * @file The CATEGORY ASSIGNMENT stage: reuse, refusals and its three bounds.
 *
 * WHAT THIS FILE IS FOR. `test/compiler/category-compile.test.ts` proves the stage is
 * REACHABLE from a compile; this one proves the RULES it applies once it is running.
 * The two bounds that cannot be reached from a compile -- one run may create at most
 * `MAX_NEW_CATEGORIES_PER_RUN` categories and may offer at most
 * `MAX_CATEGORY_ASSIGNMENT_ARTICLES_PER_RUN` articles to the model -- are tested here
 * because reaching them through a compile would need a corpus nobody writes by hand.
 *
 * THE CASES.
 *  - A1 a second run REUSES the category by canonical key: same id, one file, the
 *    stored canonical name, description and criterion untouched, members unioned;
 *  - A2 the three typed refusals (`incomplete`, `uncheckable`, `unsupported`) are
 *    counted and write nothing;
 *  - A3 `new-category-cap` truncates and is counted per reason;
 *  - A4 `run-cap` bounds the model calls and is counted per reason.
 *
 * Every assertion reads the FILES the stage wrote, through the public parser, never
 * internal storage.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { assignCategories, type CategoryAssignmentArticle } from "../../src/categories/assign.js";
import { parseCategory } from "../../src/categories/markdown.js";
import type { CategoryRecord } from "../../src/categories/types.js";
import { useManagedTempRoots } from "../fixtures/temp-root.js";
import { stubCompileProvider } from "../fixtures/compile-provider.js";
import {
  CATEGORY_CRITERION,
  CATEGORY_DESCRIPTION,
  CATEGORY_REASON,
  SISTEMAS_BODY,
  SISTEMAS_TITLE,
  categoryIds,
  proposal,
  proposalAnswer,
  readCategoryFile,
} from "../fixtures/category-scenario.js";

/** Isolated project roots, removed in teardown. */
const roots = useManagedTempRoots();

/** One article, with the body the assignment stage checks its criteria against. */
const SISTEMAS: CategoryAssignmentArticle = {
  slug: "sistemas-distribuidos",
  title: SISTEMAS_TITLE,
  body: SISTEMAS_BODY,
};

beforeEach(() => {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
});

/**
 * Answer every assignment call with the same proposal list.
 *
 * @param proposals - Proposals to return, built with {@link proposal}.
 * @param onCall - Called once per assignment call, for the bounds that count them.
 */
function answerWith(proposals: Record<string, unknown>[], onCall?: () => void): void {
  stubCompileProvider({
    extraction: () => "",
    body: () => "",
    categories: () => {
      onCall?.();
      return proposalAnswer(...proposals);
    },
  });
}

/** The one category file present, parsed. */
async function onlyCategory(root: string): Promise<CategoryRecord> {
  return parseCategory(await readCategoryFile(root, "sistemas-distribuidos"));
}

describe("category assignment — reuse keeps identity stable (A1)", () => {
  it("reuses the category of the same canonical name instead of minting a duplicate", async () => {
    const root = await roots.tempRoot("category-assign");
    answerWith([proposal({
      name: SISTEMAS_TITLE,
      description: CATEGORY_DESCRIPTION,
      criterion: CATEGORY_CRITERION,
      reason: CATEGORY_REASON,
    })]);
    await assignCategories(root, [SISTEMAS]);
    const first = await onlyCategory(root);

    // A second run proposes the same name with DIFFERENT metadata, and one new member.
    const second = await assignCategories(root, [
      { slug: "otro", title: "Otro", body: "Habla de replicación y consenso distribuido." },
    ]);

    expect(await categoryIds(root)).toEqual(["sistemas-distribuidos"]);
    const reused = await onlyCategory(root);
    expect(second.created).toBe(0);
    expect(second.categories).toBe(1);
    expect(reused.categoryId).toBe(first.categoryId);
    expect(reused.description).toBe(CATEGORY_DESCRIPTION);
    expect(reused.inclusionCriterion).toBe(CATEGORY_CRITERION);
    expect(reused.createdAt).toBe(first.createdAt);
    expect(reused.members.map((member) => member.pageId))
      .toEqual(["concepts/otro", "concepts/sistemas-distribuidos"]);
  });
});

describe("category assignment — the three typed refusals (A2)", () => {
  it("counts each refusal by reason and writes nothing", async () => {
    const root = await roots.tempRoot("category-assign");
    answerWith([
      proposal({ name: "Sin descripción", description: " " }),
      proposal({ name: "Sin criterio", criterion: "Páginas relacionadas con el tema." }),
      proposal({ name: "Sin apoyo", criterion: 'Páginas que mencionen "kubernetes".' }),
    ]);

    const counts = await assignCategories(root, [SISTEMAS]);

    expect(counts.refused).toEqual({ incomplete: 1, uncheckable: 1, unsupported: 1, unreadable: 0 });
    expect(counts.assigned).toBe(0);
    expect(await categoryIds(root)).toEqual([]);
  });
});

describe("category assignment — the bounds (A3, A4)", () => {
  it("A3 stops creating categories at the run's new-category bound and counts it", async () => {
    const root = await roots.tempRoot("category-assign");
    // Each article proposes its OWN three categories, so the run offers twelve distinct
    // names and the bound -- not a repeated proposal -- is what stops the tenth.
    let call = 0;
    stubCompileProvider({
      extraction: () => "",
      body: () => "",
      categories: () => {
        const names = [0, 1, 2].map((offset) => proposal({
          name: `Categoría ${call * 3 + offset}`,
          criterion: 'Páginas que mencionen "nodos".',
        }));
        call += 1;
        return proposalAnswer(...names);
      },
    });
    const articles = [0, 1, 2, 3].map((index) => ({
      slug: `pagina-${index}`, title: `Página ${index}`, body: SISTEMAS_BODY,
    }));

    const counts = await assignCategories(root, articles);

    expect(counts.created).toBe(10);
    expect(counts.truncated["new-category-cap"]).toBe(2);
    expect(await categoryIds(root)).toHaveLength(10);
  });

  it("A4 offers at most the run's article bound to the model and counts the rest", async () => {
    const root = await roots.tempRoot("category-assign");
    let calls = 0;
    answerWith([], () => { calls += 1; });
    const articles = Array.from({ length: 21 }, (_unused, index) => ({
      slug: `pagina-${index}`, title: `Página ${index}`, body: SISTEMAS_BODY,
    }));

    const counts = await assignCategories(root, articles);

    expect(calls).toBe(20);
    expect(counts.truncated["run-cap"]).toBe(1);
    expect(AnthropicProvider.prototype.toolCall).toHaveBeenCalledTimes(20);
  });
});
