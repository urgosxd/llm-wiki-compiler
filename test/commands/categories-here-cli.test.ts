/**
 * @file `llmwiki categories-here <page-id>` — a page's categories (S11).
 *
 * WHAT IS PROTECTED. The page-to-category direction is the one a reader needs while
 * reading an article: "what groups does this page belong to?". The command reads the
 * CATEGORY store and nothing else, so the cases pin its exact output, its envelope
 * and its exit code, including the two non-errors: a page in no category, and a name
 * that cannot be a page id at all.
 */

import { describe, it, expect } from "vitest";
import { createCategory } from "../../packages/wiki/src/categories/index.js";
import categoriesHereCommand from "../../packages/wiki/src/commands/categories-here.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureProcessIo } from "../fixtures/process-io.js";

/** Throwaway project the command runs in. */
const ctx = useTempRoot();

/** Two categories, one of which contains the page the cases ask about. */
async function seed(): Promise<void> {
  await createCategory(ctx.dir, {
    canonicalName: "Sistemas distribuidos",
    description: "Agrupa páginas sobre sistemas que coordinan varios nodos.",
    inclusionCriterion: 'Páginas que mencionen "consenso distribuido".',
    members: [{ pageId: "concepts/sistemas-distribuidos", reason: "El artículo explica el consenso distribuido." }],
  });
  await createCategory(ctx.dir, {
    canonicalName: "Teoría",
    description: "Páginas de marco teórico.",
    inclusionCriterion: 'Páginas que mencionen "definición".',
  });
}

describe("categories-here — human output", () => {
  it("lists the page's categories in id order and exits 0", async () => {
    await seed();
    const io = captureProcessIo();

    const code = await categoriesHereCommand("sistemas-distribuidos", {});

    expect(code).toBe(0);
    expect(io.err()).toBe("");
    expect(io.out()).toBe(
      "1 category(ies) contain concepts/sistemas-distribuidos:\n\n" +
        "  [[categories/sistemas-distribuidos]] Sistemas distribuidos\n\n" +
        "Run `llmwiki category <category-id>` to list a category's members.\n",
    );
  });

  it("accepts a namespaced page id and agrees with the bare slug", async () => {
    await seed();
    const bare = captureProcessIo();
    await categoriesHereCommand("sistemas-distribuidos", {});
    const namespaced = captureProcessIo();
    await categoriesHereCommand("concepts/sistemas-distribuidos", {});

    expect(namespaced.out()).toBe(bare.out());
  });

  it("reports a page in no category as a normal answer", async () => {
    await seed();
    const io = captureProcessIo();

    const code = await categoriesHereCommand("sin-categoria", {});

    expect(code).toBe(0);
    expect(io.out()).toBe(
      "No category contains concepts/sin-categoria.\n" +
        "This wiki may have no categories yet: a compile creates them as it assigns pages.\n",
    );
  });

  it("rejects a name that cannot be a page id without failing", async () => {
    await seed();
    const io = captureProcessIo();

    const code = await categoriesHereCommand("nonsense/foo", {});

    expect(code).toBe(0);
    expect(io.out()).toContain('"nonsense/foo" is not a page id this wiki records');
  });
});

describe("categories-here — JSON envelope", () => {
  it("emits the versioned envelope with the categories that contain the page", async () => {
    await seed();
    const io = captureProcessIo();

    const code = await categoriesHereCommand("sistemas-distribuidos", { json: true });

    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      version: 1,
      requested: "sistemas-distribuidos",
      pageId: "concepts/sistemas-distribuidos",
      resolved: true,
      categoryCount: 1,
      categories: [{
        categoryId: "sistemas-distribuidos",
        objectId: "categories/sistemas-distribuidos",
        canonicalName: "Sistemas distribuidos",
        description: "Agrupa páginas sobre sistemas que coordinan varios nodos.",
      }],
    });
  });

  it("emits an empty list for a page in no category", async () => {
    await seed();
    const io = captureProcessIo();

    await categoriesHereCommand("sin-categoria", { json: true });

    expect(JSON.parse(io.out())).toMatchObject({
      version: 1,
      pageId: "concepts/sin-categoria",
      resolved: true,
      categoryCount: 0,
      categories: [],
    });
  });
});
