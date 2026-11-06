/**
 * @file Category markdown: render a record into a file, parse a file back.
 *
 * ## One frontmatter dialect
 *
 * The frontmatter is produced with {@link buildFrontmatter} and read with
 * {@link parseFrontmatter} — the same YAML helpers every wiki page uses — so a
 * category file is not a second format a reader has to learn. Every field of the
 * record round-trips: what {@link parseCategory} returns from a rendered file equals
 * the record that produced it, which is what lets the file be the source of truth
 * for a category instead of a cache of one.
 *
 * ## The body is deterministic
 *
 * The body repeats the four required fields in prose and lists the members in
 * stored order, so two renders of the same record are byte-identical and a category
 * file is diffable. Nothing in the body is derived from wall clock, locale or input
 * order beyond the record itself.
 *
 * ## The member listing is bounded and says so
 *
 * The body lists at most {@link MAX_CATEGORY_MEMBERS_LISTED} member entries. The bound
 * is printed INTO the file — "N more member(s) recorded but not listed" — so a reader of
 * the page can see that the listing is partial; the complete set, each entry with its
 * reason and evidence key, stays in the frontmatter, and {@link renderCategory} also
 * returns the truncation for the caller that wants to report it programmatically.
 *
 * ## The frontmatter is the evidence, the body is the reading view
 *
 * Each member is stored as a mapping (`pageId`, `reason`, `evidenceKey`), which is what
 * makes the file self-sufficient: the body shows the page and its reason for a reader,
 * and the frontmatter keeps all three fields for anyone auditing why a page is here.
 */

import { buildFrontmatter, parseFrontmatter } from "../utils/markdown.js";
import { MAX_CATEGORY_MEMBERS_LISTED } from "../utils/constants.js";
import { sortMembers } from "./members.js";
import { requireText } from "./validation.js";
import { CategoryValidationError } from "./types.js";
import type { CategoryMember, CategoryRecord, CategoryRender, MemberTruncation } from "./types.js";

/** One member listing: the entries the body shows, plus the bound it hit if any. */
interface MemberListing {
  listed: CategoryMember[];
  truncation?: MemberTruncation;
}

/**
 * Take the head of the member list, capped at the named bound.
 *
 * @param members - The complete, already-normalised member entries.
 * @param cap - The listing bound.
 * @returns The entries to list and, only when some were left out, the truncation.
 */
function listMembers(members: readonly CategoryMember[], cap: number): MemberListing {
  if (members.length <= cap) return { listed: [...members] };
  return {
    listed: members.slice(0, cap),
    truncation: { reason: "member-cap", cap, listed: cap, omitted: members.length - cap },
  };
}

/**
 * Render one category record as the markdown file that stores it.
 *
 * @param record - The record to render.
 * @returns The file's markdown and, when the member listing was capped, the
 *   truncation.
 */
export function renderCategory(record: CategoryRecord): CategoryRender {
  const listing = listMembers(record.members, MAX_CATEGORY_MEMBERS_LISTED);
  const markdown = `${buildFrontmatter(frontmatterFor(record))}\n\n${renderBody(record, listing)}\n`;
  return listing.truncation === undefined ? { markdown } : { markdown, truncation: listing.truncation };
}

/**
 * The frontmatter fields of a category, in a fixed order so output is stable.
 *
 * The record's own field names are used verbatim: a category file declares
 * `categoryId`, `canonicalName`, `description`, `inclusionCriterion` and `members`
 * (each a `pageId`/`reason`/`evidenceKey` mapping), and never a page's
 * `title`/`summary`/`sources`, which is what keeps the two object types
 * distinguishable in the file itself.
 *
 * @param record - The record to project.
 * @returns The YAML fields.
 */
function frontmatterFor(record: CategoryRecord): Record<string, unknown> {
  return {
    categoryId: record.categoryId,
    canonicalName: record.canonicalName,
    description: record.description,
    inclusionCriterion: record.inclusionCriterion,
    members: record.members,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The prose body: name, description, inclusion criterion, member listing.
 *
 * @param record - The record to describe.
 * @param listing - The (possibly capped) member listing.
 * @returns The body markdown, without frontmatter and without a trailing newline.
 */
function renderBody(record: CategoryRecord, listing: MemberListing): string {
  const members = listing.listed.length === 0
    ? "_No member pages yet._"
    : listing.listed.map((member) => `- ${member.pageId} — ${member.reason}`).join("\n");
  const note = listing.truncation === undefined ? "" : `\n\n${truncationNote(listing.truncation)}`;
  const sections = [
    `# ${record.canonicalName}`,
    record.description,
    "## Inclusion criterion",
    record.inclusionCriterion,
    "## Members",
    members,
  ];
  return sections.join("\n\n") + note;
}

/**
 * The sentence that reports a truncated listing inside the file.
 *
 * @param truncation - The bound that fired.
 * @returns One italic line naming the cap and the number of members left unlisted.
 */
function truncationNote(truncation: MemberTruncation): string {
  return (
    `_Listing bounded at ${truncation.cap} members: ` +
    `${truncation.omitted} more member(s) recorded but not listed._`
  );
}

/**
 * Parse a category file back into a record.
 *
 * Every required field is validated here too: a file edited by hand into an invalid
 * category is refused with the same typed error a bad draft gets, rather than
 * yielding a record the rest of the system would have to defend against.
 *
 * @param content - The file's full markdown (frontmatter plus body).
 * @returns The record the file describes.
 * @throws {CategoryValidationError} When a required field is missing or unusable.
 */
export function parseCategory(content: string): CategoryRecord {
  const { meta } = parseFrontmatter(content);
  return {
    categoryId: requireText(meta.categoryId, "categoryId"),
    canonicalName: requireText(meta.canonicalName, "canonicalName"),
    description: requireText(meta.description, "description"),
    inclusionCriterion: requireText(meta.inclusionCriterion, "inclusionCriterion"),
    members: readMembers(meta.members),
    createdAt: requireText(meta.createdAt, "createdAt"),
    updatedAt: requireText(meta.updatedAt, "updatedAt"),
  };
}

/**
 * Read the `members` frontmatter field into complete member entries.
 *
 * An absent field means a category with no members, which is legitimate. A present one
 * must be a list of mappings carrying all three parts — a file that lost an entry's
 * reason is refused rather than silently repaired, because the reason IS the evidence
 * the entry exists for.
 *
 * @param raw - The raw frontmatter value.
 * @returns The ordered member entries.
 * @throws {CategoryValidationError} When the value is not a list of complete entries.
 */
function readMembers(raw: unknown): CategoryMember[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CategoryValidationError("members", "category members must be a list of member entries");
  }
  return sortMembers(raw.map((entry: unknown) => readMember(entry)));
}

/**
 * Read one stored member entry.
 *
 * @param entry - One element of the frontmatter `members` list.
 * @returns The complete entry.
 * @throws {CategoryValidationError} When it is not a mapping or a part is missing.
 */
function readMember(entry: unknown): CategoryMember {
  if (typeof entry !== "object" || entry === null) {
    throw new CategoryValidationError("members", "each stored category member must be a mapping");
  }
  const member = entry as Record<string, unknown>;
  return {
    pageId: requireText(member.pageId, "memberPageId"),
    reason: requireText(member.reason, "memberReason"),
    evidenceKey: requireText(member.evidenceKey, "memberEvidence"),
  };
}
