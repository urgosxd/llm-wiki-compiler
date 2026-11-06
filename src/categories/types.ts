/**
 * @file The CATEGORY object model — types and typed refusals.
 *
 * ## A category is not a page and not a concept
 *
 * "Una categoría y un concepto pueden compartir nombre sin ser el mismo objeto."
 * The concept "Sistemas distribuidos" explains the topic; the category "Sistemas
 * distribuidos" groups the pages about it. They are two OBJECT TYPES:
 *
 *  - a concept is a page under `wiki/concepts/<slug>.md`, identified by its slug;
 *  - a category is a record under `wiki/categories/<categoryId>.md`, identified by
 *    a {@link CategoryRecord.categoryId} that is minted ONCE from its canonical
 *    name and never recomputed, so renaming it never moves its identity or its
 *    file.
 *
 * Nothing here reads or writes a page: categories are not pages with a tag, and no
 * field of one object type appears in the other. That is what makes a name
 * collision structural (two files, two ids) instead of a convention someone has to
 * remember.
 *
 * ## The four required fields
 *
 * S10 requires a stable identity, a canonical name, a description and an inclusion
 * criterion. All four are validated: a record missing any of them is REFUSED with a
 * {@link CategoryValidationError} naming the field, never filled with a default,
 * because a category with no inclusion criterion does not say what belongs in it.
 */

/** The fields a category record carries, as a union of the names errors can name. */
export type CategoryField =
  | "categoryId"
  | "canonicalName"
  | "description"
  | "inclusionCriterion"
  | "members"
  | "memberPageId"
  | "memberReason"
  | "memberEvidence"
  | "createdAt"
  | "updatedAt";

/**
 * One member of a category, stored as EVIDENCE rather than as a bare id.
 *
 * The inclusion criterion says which pages belong; this record says why a
 * PARTICULAR page was put in, recorded at the moment it was assigned. That is what
 * makes the category file self-sufficient: months later, with no other source at
 * hand, a reader can see the page, the justification and the canonical key of the
 * criterion (or name evidence) it was judged against, and decide whether it still
 * belongs. A bare list of ids would make membership an opinion that cannot be
 * audited or re-derived.
 */
export interface CategoryMember {
  /** The member page id (`concepts/<slug>` or `queries/<slug>`), trimmed. */
  pageId: string;
  /** Why this page belongs, as recorded when it was assigned. Required. */
  reason: string;
  /**
   * Canonical key of the evidence that justified the membership: the category's own
   * inclusion criterion ({@link criterionKeyFor}) unless the caller supplied the key
   * of other name evidence. Recorded at assignment time and NOT recomputed on later
   * criterion edits — it is evidence of what justified the page THEN, not of what the
   * criterion says now.
   */
  evidenceKey: string;
}

/**
 * A member as a caller supplies it.
 *
 * `reason` is REQUIRED: an entry with no reason is refused with a typed error, never
 * stored with an empty justification. `evidenceKey` may be omitted, in which case the
 * category's own criterion key is recorded.
 */
export interface CategoryMemberDraft {
  pageId: string;
  reason: string;
  evidenceKey?: string;
}

/**
 * One category, as stored in `wiki/categories/<categoryId>.md`.
 *
 * `categoryId` is the IDENTITY: derived from the canonical name when the category
 * is created, never recomputed afterwards, and the file name and link target of
 * record. `canonicalName` is the name a reader sees and MAY change without moving
 * the identity.
 */
export interface CategoryRecord {
  /** Stable identity; also the file's stem. Minted at creation, never renamed. */
  categoryId: string;
  /** The name a reader sees. Free to change without changing {@link categoryId}. */
  canonicalName: string;
  /** What the category is about. Required and non-empty (S10). */
  description: string;
  /** The rule that says which pages belong. Required and non-empty (S10). */
  inclusionCriterion: string;
  /**
   * Member entries, each carrying the page id, the reason recorded for it and the
   * evidence key that justified it. Deduplicated by page id and ordered by page id,
   * so the stored value does not depend on the order the caller supplied.
   */
  members: CategoryMember[];
  /** ISO timestamp of creation; preserved across every update. */
  createdAt: string;
  /** ISO timestamp of the last write. */
  updatedAt: string;
}

/**
 * What a caller supplies to create a category.
 *
 * The identity is deliberately ABSENT: it is minted from `canonicalName` by the
 * store, so a caller cannot hand in an id that disagrees with the name it was
 * created from.
 */
export interface CategoryDraft {
  canonicalName: string;
  description: string;
  inclusionCriterion: string;
  /**
   * Member entries; optional (a new category may start empty). Each one needs a page
   * id and a reason, and may omit its evidence key to inherit the category's own
   * criterion key.
   */
  members?: readonly CategoryMemberDraft[];
}

/**
 * A partial change to an existing category.
 *
 * `categoryId` is not patchable: identity is stable, so it is not a field a caller
 * can move. Omitting a field leaves it as it was; supplying a blank one is refused.
 */
export type CategoryPatch = Partial<CategoryDraft>;

/**
 * The member listing was truncated by the named cap.
 *
 * Reported rather than silent (S12): the store returns it, and the rendered body
 * says it too. The member SET is never truncated — every member stays recorded in
 * the file's frontmatter, so truncation costs a reader a scroll, not data.
 */
export interface MemberTruncation {
  /** Why the listing stopped. One reason today; the union keeps it extensible. */
  reason: "member-cap";
  /** The cap that fired ({@link MAX_CATEGORY_MEMBERS_LISTED}). */
  cap: number;
  /** How many members the body lists. */
  listed: number;
  /** How many recorded member entries the body does not list. */
  omitted: number;
}

/** A rendered category file: its markdown, plus the bound it hit if it hit one. */
export interface CategoryRender {
  markdown: string;
  /** Present only when the member listing was truncated. */
  truncation?: MemberTruncation;
}

/** The result of a create or an update. */
export interface CategoryWriteResult {
  /** The record as stored. */
  record: CategoryRecord;
  /** The object identity, `categories/<categoryId>` — never a `concepts/` id. */
  objectId: string;
  /** Absolute path of the file that was written. */
  path: string;
  /** Present only when the member listing was truncated. */
  truncation?: MemberTruncation;
}

/**
 * A category record or draft is missing a required field, or carries one that is
 * not usable (blank, not a string, not a safe filename component).
 *
 * Thrown instead of defaulting: a silent default would store a category that
 * cannot answer what it is about or what belongs in it (S10).
 */
export class CategoryValidationError extends Error {
  /** The field that failed validation. */
  readonly field: CategoryField;

  constructor(field: CategoryField, message: string) {
    super(message);
    this.name = "CategoryValidationError";
    this.field = field;
  }
}

/** No category file exists for the requested id. */
export class CategoryNotFoundError extends Error {
  /** The id that has no category file. */
  readonly categoryId: string;

  constructor(categoryId: string) {
    super(`no category file for id "${categoryId}"`);
    this.name = "CategoryNotFoundError";
    this.categoryId = categoryId;
  }
}

/**
 * The trust planner refused the write (a blocked decision), so NOTHING was
 * written.
 *
 * A refusal is surfaced, never swallowed: a category that silently failed to save
 * would look identical to one that saved, and the caller is the only layer that can
 * report it.
 */
export class CategoryWriteRefusedError extends Error {
  /** The planner's composed decision (`deny`, `stage-for-review`, …). */
  readonly decision: string;

  constructor(decision: string) {
    super(`category write refused by the trust planner: ${decision}`);
    this.name = "CategoryWriteRefusedError";
    this.decision = decision;
  }
}
