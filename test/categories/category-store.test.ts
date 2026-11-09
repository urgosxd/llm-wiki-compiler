/**
 * @file Store behaviour for CATEGORIES — the second object type in the wiki.
 *
 * A category is stored as ONE markdown file per category at
 * `wiki/categories/<categoryId>.md`, written through the same trust/confinement
 * path every page write uses. These cases pin the parts of that contract the
 * object model is responsible for:
 *
 *  - N1 the file lands at the id-derived path and every required field survives
 *    the markdown round trip (frontmatter out, frontmatter back);
 *  - N3 renaming the canonical name keeps the IDENTITY (`categoryId`) and the
 *    FILE, because identity is minted once from the name at creation and never
 *    recomputed;
 *  - N4 a record missing canonical name, description or inclusion criterion is
 *    REFUSED with a typed error and NOTHING is written — not an empty file, not
 *    a directory, not a defaulted field;
 *  - N6 an empty project reads as an empty list, creates no directory and throws
 *    nothing.
 *
 * Every case drives the public store surface against an isolated temp root; no
 * assertion reads internal storage.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  CategoryValidationError,
  createCategory,
  listCategories,
  readCategory,
  updateCategory,
} from "../../packages/wiki/src/categories/index.js";
import type { CategoryDraft } from "../../packages/wiki/src/categories/index.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { categoryTempRoots } from "../fixtures/category-root.js";
import { categoryMember } from "../fixtures/category-record.js";

/** Isolated project roots for this suite; each is removed in teardown. */
const roots = categoryTempRoots();

afterEach(() => roots.cleanup());

/** The category directory, relative to a project root. */
const CATEGORIES_DIR = path.join("wiki", "categories");

/** A complete, valid draft used as the base of the refusal cases. */
const DISTRIBUTED: CategoryDraft = {
  canonicalName: "Sistemas distribuidos",
  description: "Pages about coordination between independent nodes.",
  inclusionCriterion: "Any page describing a mechanism that coordinates nodes.",
};

/** Absolute path of a category file for a given id. */
function categoryFile(root: string, categoryId: string): string {
  return path.join(root, CATEGORIES_DIR, `${categoryId}.md`);
}

describe("category store — identity and the file it lives in (N1)", () => {
  it("writes wiki/categories/<categoryId>.md and round-trips the four required fields", async () => {
    const root = await roots.tempRoot();
    const written = await createCategory(root, DISTRIBUTED);

    expect(written.record.categoryId).toBe("sistemas-distribuidos");
    expect(written.objectId).toBe("categories/sistemas-distribuidos");
    expect(written.path).toBe(categoryFile(root, "sistemas-distribuidos"));

    const content = await readFile(written.path, "utf-8");
    const { meta } = parseFrontmatter(content);
    expect(meta.categoryId).toBe("sistemas-distribuidos");
    expect(meta.canonicalName).toBe(DISTRIBUTED.canonicalName);
    expect(meta.description).toBe(DISTRIBUTED.description);
    expect(meta.inclusionCriterion).toBe(DISTRIBUTED.inclusionCriterion);
    expect(content).toContain(`# ${DISTRIBUTED.canonicalName}`);
    expect(content).toContain(DISTRIBUTED.inclusionCriterion);

    expect(await readCategory(root, "sistemas-distribuidos")).toEqual(written.record);
  });

  it("round-trips each member's page id, reason and evidence key", async () => {
    const root = await roots.tempRoot();
    const members = [
      categoryMember("concepts/consensus", "Documents the agreement protocol the criterion names."),
      categoryMember("concepts/replication", "Explains replica coordination.", "replication-evidence"),
    ];

    const written = await createCategory(root, { ...DISTRIBUTED, members });

    expect(written.record.members).toEqual([
      {
        pageId: "concepts/consensus",
        reason: "Documents the agreement protocol the criterion names.",
        evidenceKey: "any-page-describing-a-mechanism-that-coordinates-nodes",
      },
      {
        pageId: "concepts/replication",
        reason: "Explains replica coordination.",
        evidenceKey: "replication-evidence",
      },
    ]);
    const { meta, body } = parseFrontmatter(await readFile(written.path, "utf-8"));
    expect(meta.members).toEqual(written.record.members);
    expect(body).toContain("- concepts/consensus — Documents the agreement protocol the criterion names.");
    expect(await readCategory(root, "sistemas-distribuidos")).toEqual(written.record);
  });
});

describe("category store — identity survives a rename (N3)", () => {
  it("keeps categoryId and the same file when the canonical name changes", async () => {
    const root = await roots.tempRoot();
    const created = await createCategory(root, DISTRIBUTED);

    const renamed = await updateCategory(root, "sistemas-distribuidos", {
      canonicalName: "Distributed systems",
    });

    expect(renamed.record.categoryId).toBe(created.record.categoryId);
    expect(renamed.path).toBe(created.path);
    expect(await readdir(path.join(root, CATEGORIES_DIR))).toEqual(["sistemas-distribuidos.md"]);

    const { meta } = parseFrontmatter(await readFile(created.path, "utf-8"));
    expect(meta.canonicalName).toBe("Distributed systems");
    expect(meta.createdAt).toBe(created.record.createdAt);
    expect(await readCategory(root, "sistemas-distribuidos")).toEqual(renamed.record);
  });
});

describe("category store — a missing required field is refused (N4)", () => {
  const FIELD_CASES: Array<[keyof CategoryDraft, string]> = [
    ["canonicalName", "canonical name"],
    ["description", "description"],
    ["inclusionCriterion", "inclusion criterion"],
  ];

  it.each(FIELD_CASES)("refuses a draft with a blank %s and writes nothing", async (field) => {
    const root = await roots.tempRoot();
    const draft = { ...DISTRIBUTED, [field]: "   " } as CategoryDraft;

    const error = await createCategory(root, draft).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CategoryValidationError);
    expect((error as CategoryValidationError).field).toBe(field);
    expect(existsSync(path.join(root, CATEGORIES_DIR))).toBe(false);
    expect(await listCategories(root)).toEqual([]);
  });

  it("refuses an update that would blank a required field and leaves the file untouched", async () => {
    const root = await roots.tempRoot();
    const created = await createCategory(root, DISTRIBUTED);
    const before = await readFile(created.path, "utf-8");

    const error = await updateCategory(root, "sistemas-distribuidos", { description: "" }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(CategoryValidationError);
    expect((error as CategoryValidationError).field).toBe("description");
    expect(await readFile(created.path, "utf-8")).toBe(before);
  });

  it("refuses an id that is not a safe filename component and writes no file", async () => {
    const root = await roots.tempRoot();

    await expect(readCategory(root, "../escape")).rejects.toBeInstanceOf(CategoryValidationError);
    expect(existsSync(path.join(root, CATEGORIES_DIR))).toBe(false);
  });
});

describe("category store — an empty project (N6)", () => {
  it("lists no categories, creates no directory and throws nothing", async () => {
    const root = await roots.tempRoot();

    await expect(listCategories(root)).resolves.toEqual([]);
    expect(existsSync(path.join(root, CATEGORIES_DIR))).toBe(false);
  });
});
