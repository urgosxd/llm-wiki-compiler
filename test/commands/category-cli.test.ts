/**
 * @file `llmwiki category <slug>` — a category and its members (S11).
 *
 * WHAT IS PROTECTED. The command is a READ-ONLY window onto the category store, so
 * the contract worth pinning is its exact output, its JSON envelope and its exit
 * code, plus the two answers that are not errors: a category with no members and a
 * name no category answers to. Categories are created through the public store, so
 * these cases also prove the navigation reads what the store writes.
 */

import { describe, it, expect } from "vitest";
import { createCategory } from "../../packages/wiki/src/categories/index.js";
import categoryCommand from "../../packages/wiki/src/commands/category.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureProcessIo } from "../fixtures/process-io.js";

/** Throwaway project the command runs in. */
const ctx = useTempRoot();

/** The category every case navigates, with two members and their reasons. */
async function seedTwoMembers(): Promise<void> {
  await createCategory(ctx.dir, {
    canonicalName: "Sistemas distribuidos",
    description: "Agrupa páginas sobre sistemas que coordinan varios nodos.",
    inclusionCriterion: 'Páginas que mencionen "consenso distribuido".',
    members: [
      {
        pageId: "concepts/sistemas-distribuidos",
        reason: "El artículo explica el consenso distribuido.",
        evidenceKey: "consenso-distribuido",
      },
      { pageId: "concepts/almacenes-de-vectores", reason: "El artículo guarda embeddings.", evidenceKey: "embeddings" },
    ],
  });
}

describe("category — human output", () => {
  it("lists the members with their recorded reasons and exits 0", async () => {
    await seedTwoMembers();
    const io = captureProcessIo();

    const code = await categoryCommand("sistemas-distribuidos", {});

    expect(code).toBe(0);
    expect(io.err()).toBe("");
    expect(io.out()).toBe(
      "Category categories/sistemas-distribuidos — Sistemas distribuidos\n" +
        "Agrupa páginas sobre sistemas que coordinan varios nodos.\n" +
        'Inclusion criterion: Páginas que mencionen "consenso distribuido".\n\n' +
        "2 member page(s):\n\n" +
        "  [[concepts/almacenes-de-vectores]] El artículo guarda embeddings.\n" +
        "  [[concepts/sistemas-distribuidos]] El artículo explica el consenso distribuido.\n\n" +
        "Run `llmwiki categories-here <page-id>` on any member to see its categories.\n",
    );
  });

  it("resolves a namespaced object id and a canonical name as well as a bare id", async () => {
    await seedTwoMembers();
    for (const requested of ["categories/sistemas-distribuidos", "Sistemas distribuidos"]) {
      const io = captureProcessIo();
      expect(await categoryCommand(requested, {})).toBe(0);
      expect(io.out()).toContain("Category categories/sistemas-distribuidos — Sistemas distribuidos\n");
    }
  });

  it("reports an empty category as a normal answer, not an error", async () => {
    await createCategory(ctx.dir, {
      canonicalName: "Teoría",
      description: "Páginas de marco teórico.",
      inclusionCriterion: 'Páginas que mencionen "definición".',
    });
    const io = captureProcessIo();

    const code = await categoryCommand("Teoría", {});

    expect(code).toBe(0);
    expect(io.out()).toContain("No member pages yet.\n");
    expect(io.out()).toContain("An empty category is normal");
  });

  it("says so when no category answers to the requested name", async () => {
    const io = captureProcessIo();

    const code = await categoryCommand("missing", {});

    expect(code).toBe(0);
    expect(io.out()).toBe(
      'No category named "missing" exists in this wiki.\n' +
        "Categories are created by a compile that assigns pages to them.\n",
    );
  });
});

describe("category — JSON envelope", () => {
  it("emits the versioned envelope with every stored field and member", async () => {
    await seedTwoMembers();
    const io = captureProcessIo();

    const code = await categoryCommand("sistemas-distribuidos", { json: true });

    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      version: 1,
      requested: "sistemas-distribuidos",
      resolved: true,
      categoryId: "sistemas-distribuidos",
      objectId: "categories/sistemas-distribuidos",
      canonicalName: "Sistemas distribuidos",
      description: "Agrupa páginas sobre sistemas que coordinan varios nodos.",
      inclusionCriterion: 'Páginas que mencionen "consenso distribuido".',
      memberCount: 2,
      members: [
        {
          pageId: "concepts/almacenes-de-vectores",
          reason: "El artículo guarda embeddings.",
          evidenceKey: "embeddings",
        },
        {
          pageId: "concepts/sistemas-distribuidos",
          reason: "El artículo explica el consenso distribuido.",
          evidenceKey: "consenso-distribuido",
        },
      ],
    });
  });

  it("marks an unknown category unresolved instead of failing", async () => {
    const io = captureProcessIo();

    const code = await categoryCommand("missing", { json: true });

    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      version: 1,
      requested: "missing",
      resolved: false,
      categoryId: null,
      objectId: null,
      canonicalName: null,
      description: null,
      inclusionCriterion: null,
      memberCount: 0,
      members: [],
    });
  });
});
