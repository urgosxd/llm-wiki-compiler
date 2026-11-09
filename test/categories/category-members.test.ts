/**
 * @file Category MEMBERS: bounded, deterministic, evidence-bearing entries (N5, N7, N8).
 *
 * A member is not a bare page id. Every entry records the page, the reason it was
 * assigned and the canonical key of the evidence that justified it, so a category
 * file answers "why is this page here?" on its own, after the fact, with no other
 * source consulted (S10's inclusion criterion turned into auditable data).
 *
 * Three properties are load-bearing and pinned here:
 *
 *  - THE BOUND IS NAMED AND REPORTED. The rendered listing stops at
 *    `MAX_CATEGORY_MEMBERS_LISTED` entries and says so, both in the returned result
 *    and in the file; the complete set stays in the frontmatter, so truncation costs
 *    a reader a scroll, not evidence.
 *  - ORDER IS A FUNCTION OF THE SET. Entries are ordered by page id, so the same set
 *    produces the same file whatever order the caller passed, and each reason travels
 *    with the page it justifies.
 *  - NO UNJUSTIFIED MEMBER. An entry with a missing or blank reason is REFUSED with a
 *    typed error and nothing is written — a membership nobody can explain is the
 *    drift the criterion exists to prevent (N8).
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  CategoryValidationError,
  createCategory,
  listCategories,
  readCategory,
} from "../../packages/wiki/src/categories/index.js";
import type { CategoryMemberDraft } from "../../packages/wiki/src/categories/index.js";
import { MAX_CATEGORY_MEMBERS_LISTED } from "../../packages/wiki/src/utils/constants.js";
import { parseFrontmatter } from "../../packages/wiki/src/utils/markdown.js";
import { categoryTempRoots } from "../fixtures/category-root.js";
import { categoryMember } from "../fixtures/category-record.js";

/** Isolated project roots for this suite; each is removed in teardown. */
const roots = categoryTempRoots();

afterEach(() => roots.cleanup());

/** The category name used throughout; `sistemas-distribuidos` once slugified. */
const NAME = "Sistemas distribuidos";

/** A valid draft whose only variable is the member list. */
function draftWith(members: CategoryMemberDraft[]) {
  return {
    canonicalName: NAME,
    description: "Pages about coordination between independent nodes.",
    inclusionCriterion: "Any page describing node coordination.",
    members,
  };
}

/** The page ids a rendered category lists, in file order. */
function listedMembers(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(" — ")[0].trim());
}

/** `count` member entries, zero-padded so their sorted order equals their index order. */
function memberEntries(count: number): CategoryMemberDraft[] {
  return Array.from({ length: count }, (_, index) => {
    const pageId = `concepts/page-${String(index).padStart(3, "0")}`;
    return categoryMember(pageId, `Justified by the criterion: ${pageId}.`);
  });
}

describe("category members — the bound is named and reported (N5)", () => {
  it("truncates the listing at the cap and reports how many entries it omitted", async () => {
    const root = await roots.tempRoot();
    const members = memberEntries(MAX_CATEGORY_MEMBERS_LISTED + 2);

    const written = await createCategory(root, draftWith(members));

    expect(written.truncation).toEqual({
      reason: "member-cap",
      cap: MAX_CATEGORY_MEMBERS_LISTED,
      listed: MAX_CATEGORY_MEMBERS_LISTED,
      omitted: 2,
    });
    const content = await readFile(written.path, "utf-8");
    const { meta, body } = parseFrontmatter(content);
    expect(meta.members).toHaveLength(members.length);
    expect(listedMembers(body)).toEqual(members.slice(0, MAX_CATEGORY_MEMBERS_LISTED).map((m) => m.pageId));
    expect(content).toContain("2 more member(s) recorded but not listed");
  });

  it("lists every entry in order when the set is smaller than the cap", async () => {
    const root = await roots.tempRoot();
    const members = [
      categoryMember("concepts/gamma", "Documents the failure model."),
      categoryMember("concepts/alpha", "Explains the coordination primitive."),
      categoryMember("concepts/beta", "Describes consensus under partitions."),
    ];

    const written = await createCategory(root, draftWith(members));

    expect(written.truncation).toBeUndefined();
    const { body } = parseFrontmatter(await readFile(written.path, "utf-8"));
    expect(listedMembers(body)).toEqual(["concepts/alpha", "concepts/beta", "concepts/gamma"]);
  });
});

describe("category members — deterministic order (N7)", () => {
  it("stores and renders the same order for the same set whatever the input order", async () => {
    const members = [
      categoryMember("concepts/gamma", "Documents the failure model."),
      categoryMember("concepts/alpha", "Explains the coordination primitive."),
      categoryMember("concepts/beta", "Describes consensus under partitions."),
    ];
    const first = await roots.tempRoot();
    const second = await roots.tempRoot();

    const writtenFirst = await createCategory(first, draftWith(members));
    const writtenSecond = await createCategory(second, draftWith([...members].reverse()));

    const sorted = ["concepts/alpha", "concepts/beta", "concepts/gamma"];
    expect(writtenFirst.record.members.map((member) => member.pageId)).toEqual(sorted);
    expect(writtenSecond.record.members.map((member) => member.pageId)).toEqual(sorted);
    // The reason travels with its page instead of being re-paired by position.
    expect(writtenSecond.record.members[0]?.reason).toBe("Explains the coordination primitive.");

    const firstBody = parseFrontmatter(await readFile(writtenFirst.path, "utf-8")).body;
    const secondBody = parseFrontmatter(await readFile(writtenSecond.path, "utf-8")).body;
    expect(listedMembers(firstBody)).toEqual(sorted);
    expect(listedMembers(secondBody)).toEqual(sorted);
    expect(secondBody).toBe(firstBody);
  });

  it("counts a repeated member once instead of listing it twice", async () => {
    const root = await roots.tempRoot();

    const written = await createCategory(
      root,
      draftWith([
        categoryMember("concepts/alpha", "Explains the coordination primitive."),
        categoryMember("concepts/alpha", "Explains the coordination primitive."),
        categoryMember(" concepts/beta ", "Describes consensus under partitions."),
      ]),
    );

    expect(written.record.members.map((member) => member.pageId)).toEqual([
      "concepts/alpha",
      "concepts/beta",
    ]);
  });
});

describe("category members — every member carries its reason (N8)", () => {
  it("refuses an entry with no reason, or a blank one, and writes nothing", async () => {
    const root = await roots.tempRoot();
    const noReason = [{ pageId: "concepts/alpha" } as unknown as CategoryMemberDraft];

    const missing = await createCategory(root, draftWith(noReason)).catch((err: unknown) => err);
    const blank = await createCategory(root, draftWith([categoryMember("concepts/alpha", "  ")])).catch(
      (err: unknown) => err,
    );

    expect(missing).toBeInstanceOf(CategoryValidationError);
    expect((missing as CategoryValidationError).field).toBe("memberReason");
    expect(blank).toBeInstanceOf(CategoryValidationError);
    expect((blank as CategoryValidationError).field).toBe("memberReason");
    expect(existsSync(path.join(root, "wiki", "categories"))).toBe(false);
    expect(await listCategories(root)).toEqual([]);
  });

  it("records the criterion key as the evidence of an entry that supplies none", async () => {
    const root = await roots.tempRoot();

    const written = await createCategory(
      root,
      draftWith([categoryMember("concepts/alpha", "Explains the coordination primitive.")]),
    );

    expect(written.record.members[0]?.evidenceKey).toBe("any-page-describing-node-coordination");
    expect((await readCategory(root, "sistemas-distribuidos"))?.members).toEqual(written.record.members);
  });
});
