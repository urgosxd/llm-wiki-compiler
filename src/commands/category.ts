/**
 * @file `llmwiki category <slug>` — one category and the pages it groups (S11).
 *
 * A category is a navigation surface, and half of navigability is this direction:
 * from a category to its members. Every member entry carries the reason it was
 * admitted and the canonical key of the evidence that justified it, so the list this
 * command prints is auditable rather than an opinion — a reader can see WHY a page is
 * grouped here, not only that it is.
 *
 * READ-ONLY and provider-free. It reads the category store (files under
 * `wiki/categories/`) and nothing else: no page is read, no lock is taken, no model is
 * called. The members come back in the one stored order — page id, then reason, then
 * evidence key — so two runs of the command on the same wiki print the same bytes.
 *
 * A category with no members is a normal answer, not an error: a category created by the
 * first run that opened it legitimately groups one page at a time. The exit code stays
 * 0 and the envelope reports an empty list, so a caller can tell "empty" from "failed"
 * without parsing prose.
 *
 * A CONCEPT AND A CATEGORY MAY SHARE A NAME, and this command must not confuse them:
 * the object id it prints is always `categories/<id>`, never `concepts/<slug>`, and a
 * page whose title happens to match a category is never listed here unless a compile
 * really assigned it.
 */

import { listCategories } from "../categories/store.js";
import { categoryObjectId } from "../categories/identity.js";
import { canonicalConceptKey } from "../dimensions/wiki/concept-identity.js";
import type { CategoryMember, CategoryRecord } from "../categories/types.js";

/** Versioned JSON envelope, incremented independently of other commands. */
const CATEGORY_JSON_VERSION = 1;

/** CLI options for `llmwiki category`. */
export interface CategoryCommandOptions {
  /** Emit the stable JSON envelope instead of the human list. */
  json?: boolean;
}

/** One member as reported to the caller. */
interface ReportedMember {
  pageId: string;
  reason: string;
  evidenceKey: string;
}

/**
 * Find the category a requested name refers to.
 *
 * Three tiers, in this order, each deterministic: the exact id, then the canonical key
 * of a canonical NAME, then the canonical key of an id. The key rule is the one the wiki
 * uses for concept names, so `Sistemas distribuidos` finds `sistemas-distribuidos`
 * without the caller having to guess the slug. Categories are listed in id order and the
 * first match wins, so an ambiguous request cannot answer differently between runs.
 *
 * @param requested - A bare id, a `categories/<id>` object id, or a canonical name.
 * @param categories - Every category in the wiki, in id order.
 * @returns The matching category, or null when none does.
 */
function resolveCategory(
  requested: string,
  categories: readonly CategoryRecord[],
): CategoryRecord | null {
  const bare = requested.startsWith("categories/") ? requested.slice("categories/".length) : requested;
  const exact = categories.find((record) => record.categoryId === bare);
  if (exact !== undefined) return exact;
  const key = canonicalConceptKey(bare);
  return categories.find((record) => canonicalConceptKey(record.canonicalName) === key)
    ?? categories.find((record) => canonicalConceptKey(record.categoryId) === key)
    ?? null;
}

/** Project the stored members into what a caller is told, in stored order. */
function reportedMembers(members: readonly CategoryMember[]): ReportedMember[] {
  return members.map((member) => ({
    pageId: member.pageId,
    reason: member.reason,
    evidenceKey: member.evidenceKey,
  }));
}

/**
 * Render the human-readable answer for a category.
 *
 * @param record - The category that resolved.
 * @param members - Its members, in stored order.
 * @returns The text to print, without a trailing newline.
 */
function renderHuman(record: CategoryRecord, members: readonly ReportedMember[]): string {
  const header = [
    `Category ${categoryObjectId(record.categoryId)} — ${record.canonicalName}`,
    record.description,
    `Inclusion criterion: ${record.inclusionCriterion}`,
  ];
  if (members.length === 0) {
    return [
      ...header,
      "",
      "No member pages yet.",
      "An empty category is normal: members appear as compiles assign pages to it.",
    ].join("\n");
  }
  const listed = members.map((member) => `  [[${member.pageId}]] ${member.reason}`);
  return [
    ...header,
    "",
    `${members.length} member page(s):`,
    "",
    ...listed,
    "",
    "Run `llmwiki categories-here <page-id>` on any member to see its categories.",
  ].join("\n");
}

/**
 * The four stored attributes plus the identity, or nulls when nothing resolved.
 *
 * Split out of {@link buildJsonPayload} so the envelope stays a plain object literal:
 * every field is present in BOTH cases on purpose, because a consumer that has to test
 * for a missing key instead of reading `null` is a consumer that will get it wrong.
 *
 * @param record - The category that resolved, or null.
 * @returns The identity block of the envelope.
 */
function identityBlock(record: CategoryRecord | null) {
  if (record === null) {
    return {
      categoryId: null,
      objectId: null,
      canonicalName: null,
      description: null,
      inclusionCriterion: null,
    };
  }
  return {
    categoryId: record.categoryId,
    objectId: categoryObjectId(record.categoryId),
    canonicalName: record.canonicalName,
    description: record.description,
    inclusionCriterion: record.inclusionCriterion,
  };
}

/** The stable JSON envelope, for a resolved category or for an unknown name. */
function buildJsonPayload(requested: string, record: CategoryRecord | null, members: readonly ReportedMember[]) {
  return {
    version: CATEGORY_JSON_VERSION,
    requested,
    resolved: record !== null,
    ...identityBlock(record),
    memberCount: members.length,
    members,
  };
}

/**
 * Run `llmwiki category <slug>`.
 * @param requested - Bare category id, `categories/<id>` object id, or canonical name.
 * @param options - `--json` switches to the stable envelope.
 * @returns Process exit code; always 0 for a successful inspection.
 */
export default async function categoryCommand(
  requested: string,
  options: CategoryCommandOptions = {},
): Promise<number> {
  const record = resolveCategory(requested, await listCategories(process.cwd()));
  const members = record === null ? [] : reportedMembers(record.members);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildJsonPayload(requested, record, members), null, 2)}\n`);
  } else if (record === null) {
    process.stdout.write(
      `No category named "${requested}" exists in this wiki.\n` +
        "Categories are created by a compile that assigns pages to them.\n",
    );
  } else {
    process.stdout.write(`${renderHuman(record, members)}\n`);
  }
  return 0;
}
