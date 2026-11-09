/**
 * @file The name-collision proof: a category is not a concept (S4).
 *
 * "Una categoría y un concepto pueden compartir nombre sin ser el mismo objeto."
 * The claim is structural, not stylistic, and these cases pin the structure:
 *
 *  - the SAME name produces TWO files in TWO directories (`wiki/concepts/…` and
 *    `wiki/categories/…`), because a category is not stored as a page;
 *  - the two objects have DIFFERENT identities (`concepts/<slug>` versus
 *    `categories/<categoryId>`), so no id can ever stand for both;
 *  - creating the category does not touch the concept page — byte for byte — and
 *    the concept does not absorb the category or vice versa: each stays readable
 *    as what it is, with its own fields.
 *
 * If any of these breaks, the collision has merged the two objects and S4 is
 * violated no matter what the API is called.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createCategory, listCategories, readCategory } from "../../packages/wiki/src/categories/index.js";
import { readPageRecord } from "../../packages/wiki/src/pages/read.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { categoryTempRoots } from "../fixtures/category-root.js";
import { categoryMember } from "../fixtures/category-record.js";

/** Isolated project roots for this suite; each is removed in teardown. */
const roots = categoryTempRoots();

afterEach(() => roots.cleanup());

/** The shared name from the spec: a concept about the topic AND a category over it. */
const SHARED_NAME = "Sistemas distribuidos";

/** The slug both objects derive from that name — deliberately the same stem. */
const SHARED_STEM = "sistemas-distribuidos";

/** A concept page as the compiler writes one: a page with page frontmatter. */
const CONCEPT_PAGE = [
  "---",
  `title: ${SHARED_NAME}`,
  "summary: How independent nodes coordinate over a network.",
  "sources:",
  "  - sources/distributed.md",
  "kind: concept",
  "createdAt: 2024-01-01T00:00:00.000Z",
  "updatedAt: 2024-01-02T00:00:00.000Z",
  "---",
  "",
  `# ${SHARED_NAME}`,
  "",
  "A distributed system is a set of independent nodes that appear to users as one system.",
  "",
].join("\n");

describe("category versus concept — same name, two objects (N2)", () => {
  it("keeps two files, two identities, and neither record absorbs the other", async () => {
    const root = await roots.tempRoot();
    const conceptFile = path.join(root, "wiki", "concepts", `${SHARED_STEM}.md`);
    await mkdir(path.dirname(conceptFile), { recursive: true });
    await writeFile(conceptFile, CONCEPT_PAGE, "utf-8");

    const category = await createCategory(root, {
      canonicalName: SHARED_NAME,
      description: "Groups every page about coordinating independent nodes.",
      inclusionCriterion: "Any page describing node coordination.",
      members: [categoryMember("concepts/consensus", "Explains the agreement protocol.")],
    });

    // Two files, in two directories, derived from the same name.
    expect(await readFile(conceptFile, "utf-8")).toBe(CONCEPT_PAGE);
    expect(category.path).toBe(path.join(root, "wiki", "categories", `${SHARED_STEM}.md`));
    expect(await readdir(path.join(root, "wiki", "concepts"))).toEqual([`${SHARED_STEM}.md`]);
    expect(await readdir(path.join(root, "wiki", "categories"))).toEqual([`${SHARED_STEM}.md`]);

    // Two distinct identities: a category id can never name a concept.
    expect(category.objectId).toBe(`categories/${SHARED_STEM}`);
    expect(`concepts/${SHARED_STEM}`).not.toBe(category.objectId);

    // Each object still reads as what it is.
    const concept = await readPageRecord(root, SHARED_STEM);
    expect(concept?.title).toBe(SHARED_NAME);
    expect(concept?.summary).toBe("How independent nodes coordinate over a network.");
    expect(concept?.body).toContain("independent nodes that appear to users as one system");

    const categoryRecord = await readCategory(root, SHARED_STEM);
    expect(categoryRecord?.canonicalName).toBe(SHARED_NAME);
    expect(categoryRecord?.members.map((member) => member.pageId)).toEqual(["concepts/consensus"]);
    expect(categoryRecord?.members[0]?.reason).toBe("Explains the agreement protocol.");
    expect(Object.keys(categoryRecord ?? {})).not.toContain("summary");
    expect(await listCategories(root)).toEqual([category.record]);
  });

  it("stores the category with category frontmatter and no page frontmatter", async () => {
    const root = await roots.tempRoot();
    const written = await createCategory(root, {
      canonicalName: SHARED_NAME,
      description: "Groups every page about coordinating independent nodes.",
      inclusionCriterion: "Any page describing node coordination.",
    });

    const { meta } = parseFrontmatter(await readFile(written.path, "utf-8"));
    expect(meta.categoryId).toBe(SHARED_STEM);
    expect(meta.title).toBeUndefined();
    expect(meta.summary).toBeUndefined();
    expect(meta.sources).toBeUndefined();
    expect(existsSync(path.join(root, "wiki", "concepts", `${SHARED_STEM}.md`))).toBe(false);
  });
});
