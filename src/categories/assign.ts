/**
 * @file The CATEGORY ASSIGNMENT stage: from a compiled article to a category file (S10).
 *
 * ## What one run does
 *
 * For the articles a compile created or updated, ask the model which categories each
 * belongs to, then DECIDE in code whether the answer becomes a category:
 *
 *  1. the article must SATISFY its own proposal's criterion — the criterion's quoted
 *     terms are tested against the article's rendered text (`criteria.ts`), and an
 *     unsatisfied criterion is refused as `unsupported`;
 *  2. an existing category with the same canonical NAME KEY is reused, so identity and
 *     file stay stable across runs and a second ingest cannot mint a duplicate;
 *  3. the membership is recorded as EVIDENCE — the page id, the reason the model gave
 *     for THIS page and the canonical key of the term that admitted it — so the
 *     category file alone explains why each page is in it;
 *  4. the write goes through the category store, which plans it with the trust planner
 *     and applies it with the journalled executor. Nothing here writes bytes.
 *
 * ## Reuse is decided by key, never by spelling
 *
 * Matching a proposal to a category compares `canonicalConceptKey` of the canonical
 * names — the SAME rule the wiki uses to decide that two concept names are the same
 * concept — so "Sistemas Distribuidos", "sistemas distribuidos" and "Sistema
 * distribuido" all land on the category that already exists. Raw string equality would
 * mint a near-duplicate per capitalization, which is exactly how a taxonomy rots. The
 * model is shown the existing names as context, but it does not decide reuse.
 *
 * ## A category is not a page
 *
 * Nothing in this module reads or writes `wiki/concepts/`. The article's text is READ
 * (to test the criterion) and the category is WRITTEN to its own directory under its
 * own identity, which is why a concept and a category sharing the name "Sistemas
 * distribuidos" are two files that cannot merge (`S4`).
 *
 * ## Bounds, all three counted and reported
 *
 * `MAX_CATEGORIES_PER_ARTICLE` (`article-cap`), `MAX_NEW_CATEGORIES_PER_RUN`
 * (`new-category-cap`) and `MAX_CATEGORY_ASSIGNMENT_ARTICLES_PER_RUN` (`run-cap`), all
 * in `constants.ts` beside their reasons. A run that hits one reports it (S12).
 *
 * ## Failure is never fatal
 *
 * A provider failure counts as an `unreadable` answer and a refused write counts as
 * `writeFailed` with a warning line: categorisation improves the wiki, it is not a
 * precondition for publishing it. What it never does is fail silently — every refused
 * proposal, every dropped article and every refused write is counted.
 */

import { createCategory, listCategories, updateCategory } from "./store.js";
import { matchingCriterionTerm, evidenceKeyFor } from "./criteria.js";
import {
  parseCategoryProposals,
  readProposals,
  PROPOSAL_REFUSALS,
  type CategoryProposal,
  type ProposalRefusal,
} from "./proposals.js";
import { canonicalConceptKey } from "../dimensions/wiki/concept-identity.js";
import { buildCategoryAssignmentPrompt, CATEGORY_ASSIGNMENT_TOOL } from "./prompt.js";
import { callClaude } from "../utils/llm.js";
import {
  MAX_CATEGORIES_PER_ARTICLE,
  MAX_CATEGORY_ASSIGNMENT_ARTICLES_PER_RUN,
  MAX_NEW_CATEGORIES_PER_RUN,
} from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { CategoryMemberDraft, CategoryRecord } from "./types.js";

/** Why a bound dropped work. One reason per named bound. */
export type CategoryAssignmentTruncationReason = "article-cap" | "run-cap" | "new-category-cap";

/** Every truncation reason, so the fold and the report iterate instead of restating it. */
const CATEGORY_TRUNCATION_REASONS: readonly CategoryAssignmentTruncationReason[] = [
  "article-cap",
  "run-cap",
  "new-category-cap",
];

/**
 * Where the stage's writes go.
 *
 * `lockHeld` is passed straight to the store, because the ONLY production caller is a
 * compile, which holds the project lock for its whole pipeline: re-acquiring it there is
 * refused and every membership of the run would be lost while the run claimed success.
 * The default acquires, so a caller outside a compile keeps the ordinary guarantee.
 */
export interface CategoryAssignmentOptions {
  /** True when the caller already holds the project lock (a compile does). */
  lockHeld?: boolean;
}

/** One article offered to the stage: its page id, its title and its rendered text. */
export interface CategoryAssignmentArticle {
  /** Concept slug, i.e. the page id under `concepts/`. */
  slug: string;
  /** The page's title, which is the article's canonical name. */
  title: string;
  /** The page's rendered body, which the proposal is checked against. */
  body: string;
}

/** What one run of the stage decided, in the numbers the compile reports. */
export interface CategoryAssignmentCounts {
  /** Articles offered to the model. */
  articles: number;
  /** Memberships committed to a category file this run. */
  assigned: number;
  /** Distinct categories touched this run (created plus updated). */
  categories: number;
  /** Categories created this run. */
  created: number;
  /** Existing categories that gained a member this run. */
  updated: number;
  /** Proposals refused, per reason. */
  refused: Record<ProposalRefusal, number>;
  /** Work dropped by a named bound, per reason. */
  truncated: Record<CategoryAssignmentTruncationReason, number>;
  /** Category writes the trust floor refused. Never silent: each is also warned. */
  writeFailed: number;
}

/** One category being assembled by the run, whether or not it exists yet. */
interface PlannedCategory {
  /** The stored record when the category already exists; null when it is new. */
  existing: CategoryRecord | null;
  canonicalName: string;
  description: string;
  inclusionCriterion: string;
  members: CategoryMemberDraft[];
  /** Whether the member set really grew, so an unchanged category is not rewritten. */
  dirty: boolean;
}

/** Counts with nothing done yet. */
export function emptyCategoryAssignmentCounts(): CategoryAssignmentCounts {
  return {
    articles: 0,
    assigned: 0,
    categories: 0,
    created: 0,
    updated: 0,
    refused: { incomplete: 0, uncheckable: 0, unsupported: 0, unreadable: 0 },
    truncated: { "article-cap": 0, "run-cap": 0, "new-category-cap": 0 },
    writeFailed: 0,
  };
}

/**
 * Fold one stage run's counts into a compile's running total.
 *
 * @param total - The run's total, mutated in place.
 * @param counts - What one invocation of {@link assignCategories} decided.
 */
export function addCategoryAssignmentCounts(
  total: CategoryAssignmentCounts,
  counts: CategoryAssignmentCounts,
): void {
  total.articles += counts.articles;
  total.assigned += counts.assigned;
  total.categories += counts.categories;
  total.created += counts.created;
  total.updated += counts.updated;
  total.writeFailed += counts.writeFailed;
  for (const reason of PROPOSAL_REFUSALS) total.refused[reason] += counts.refused[reason];
  for (const reason of CATEGORY_TRUNCATION_REASONS) total.truncated[reason] += counts.truncated[reason];
}

/** Whether a bound dropped anything, which makes the report line a warning. */
export function hasCategoryAssignmentTruncation(counts: CategoryAssignmentCounts): boolean {
  return CATEGORY_TRUNCATION_REASONS.some((reason) => counts.truncated[reason] > 0);
}

/**
 * One line describing what category assignment did, or null when it did nothing.
 *
 * Silence means the model proposed nothing and no bound fired — the normal run of a
 * project whose articles already belong where they belong. Every refusal and every
 * dropped article is named with its own count, so an operator can tell which reason to
 * act on, and a bound that fired is never mistaken for a quiet run (S12).
 *
 * @param counts - The run's totals for this stage.
 * @returns The summary text, or null when there is nothing to report.
 */
export function describeCategoryAssignment(counts: CategoryAssignmentCounts): string | null {
  const refusedTotal = PROPOSAL_REFUSALS.reduce((sum, reason) => sum + counts.refused[reason], 0);
  if (counts.assigned === 0 && refusedTotal === 0 && counts.writeFailed === 0
    && !hasCategoryAssignmentTruncation(counts)) return null;
  const newPart = counts.created > 0 ? ` (${counts.created} new)` : "";
  const parts = [`${counts.assigned} page(s) assigned to ${counts.categories} category(ies)${newPart}`];
  if (refusedTotal > 0) {
    const named = PROPOSAL_REFUSALS
      .filter((reason) => counts.refused[reason] > 0)
      .map((reason) => `${counts.refused[reason]} ${reason}`);
    parts.push(`${refusedTotal} refused (${named.join(", ")})`);
  }
  const truncated = CATEGORY_TRUNCATION_REASONS
    .filter((reason) => counts.truncated[reason] > 0)
    .map((reason) => `${counts.truncated[reason]} ${reason}`);
  if (truncated.length > 0) parts.push(`truncated ${truncated.join(", ")}`);
  if (counts.writeFailed > 0) parts.push(`${counts.writeFailed} write(s) refused`);
  return parts.join(", ");
}

/**
 * Assign the articles of one run to categories.
 *
 * @param root - Project root the reads and writes are confined under.
 * @param articles - Articles this run created or updated, each with its rendered body.
 * @param options - Where the writes go; see {@link CategoryAssignmentOptions}.
 * @returns What this run assigned, created, refused and truncated.
 */
export async function assignCategories(
  root: string,
  articles: readonly CategoryAssignmentArticle[],
  options: CategoryAssignmentOptions = {},
): Promise<CategoryAssignmentCounts> {
  const counts = emptyCategoryAssignmentCounts();
  counts.articles = articles.length;
  if (articles.length === 0) return counts;
  const planned = new Map<string, PlannedCategory>();
  for (const record of await listCategories(root)) planned.set(canonicalConceptKey(record.canonicalName), existingPlan(record));
  await offerArticles(articles, planned, counts);
  await flushCategories(root, planned, counts, options);
  return counts;
}

/** The plan for a category that already exists, seeded with its stored members. */
function existingPlan(record: CategoryRecord): PlannedCategory {
  return {
    existing: record,
    canonicalName: record.canonicalName,
    description: record.description,
    inclusionCriterion: record.inclusionCriterion,
    members: [...record.members],
    dirty: false,
  };
}

/**
 * Offer each article to the model, bounded by the run's article budget.
 *
 * @param articles - Articles this run wrote.
 * @param planned - Categories known so far, grown in place.
 * @param counts - Totals to fill.
 */
async function offerArticles(
  articles: readonly CategoryAssignmentArticle[],
  planned: Map<string, PlannedCategory>,
  counts: CategoryAssignmentCounts,
): Promise<void> {
  for (const [index, article] of articles.entries()) {
    if (index >= MAX_CATEGORY_ASSIGNMENT_ARTICLES_PER_RUN) {
      counts.truncated["run-cap"] += 1;
      continue;
    }
    for (const proposal of await proposalsFor(article, planned, counts)) planProposal(proposal, article, planned, counts);
  }
}

/**
 * The validated proposals for one article, capped per article.
 *
 * The cap is applied to the RAW list, in the model's own order: that order is its
 * preference, so the categories it thought most apt are the ones that survive, and
 * every dropped proposal is counted rather than forgotten.
 *
 * @param article - The article being categorised.
 * @param planned - Categories known so far, for the names shown to the model.
 * @param counts - Totals to fill with refusals.
 * @returns The proposals worth planning.
 */
async function proposalsFor(
  article: CategoryAssignmentArticle,
  planned: Map<string, PlannedCategory>,
  counts: CategoryAssignmentCounts,
): Promise<CategoryProposal[]> {
  const raw = await requestProposals(article, [...planned.values()].map((plan) => plan.canonicalName));
  if (raw === null) {
    counts.refused.unreadable += 1;
    return [];
  }
  if (raw.length > MAX_CATEGORIES_PER_ARTICLE) counts.truncated["article-cap"] += raw.length - MAX_CATEGORIES_PER_ARTICLE;
  return readProposals(raw.slice(0, MAX_CATEGORIES_PER_ARTICLE), counts.refused);
}

/**
 * One assignment call. A provider failure is an unreadable answer, never a failed
 * compile.
 *
 * @param article - The article being categorised.
 * @param existingNames - Canonical names of the categories known so far.
 * @returns The raw proposal list, or null when the answer could not be read.
 */
async function requestProposals(
  article: CategoryAssignmentArticle,
  existingNames: readonly string[],
): Promise<unknown[] | null> {
  const system = buildCategoryAssignmentPrompt({
    articleTitle: article.title,
    existingCategories: existingNames.slice().sort(),
  });
  try {
    // No explicit `maxTokens`: the operator's configured output budget applies, exactly
    // as it does to extraction and page generation. Pinning a smaller number here would
    // make one phase of the compile silently ignore LLMWIKI_MAX_TOKENS.
    const raw = await callClaude({
      system,
      messages: [{ role: "user", content: `Which categories does "${article.title}" belong to?` }],
      tools: [CATEGORY_ASSIGNMENT_TOOL],
    });
    return parseCategoryProposals(raw);
  } catch {
    return null;
  }
}

/**
 * Turn one proposal into a planned membership, or count why it is not one.
 *
 * @param proposal - The validated proposal.
 * @param article - The article it was proposed for.
 * @param planned - Categories known so far, grown in place.
 * @param counts - Totals to fill.
 */
function planProposal(
  proposal: CategoryProposal,
  article: CategoryAssignmentArticle,
  planned: Map<string, PlannedCategory>,
  counts: CategoryAssignmentCounts,
): void {
  const term = matchingCriterionTerm(article.body, proposal.terms);
  if (term === null) {
    counts.refused.unsupported += 1;
    return;
  }
  const key = canonicalConceptKey(proposal.canonicalName);
  const existingPlanning = planned.get(key) ?? newPlanFor(proposal, key, planned, counts);
  if (existingPlanning === null) return;
  addMember(existingPlanning, article, proposal.reason, term, counts);
}

/**
 * The plan a proposal starts when no known category answers to its name key.
 *
 * @param proposal - The proposal.
 * @param key - The proposal's canonical name key.
 * @param planned - Categories known so far, grown in place.
 * @param counts - Totals to fill when the new-category bound refuses it.
 * @returns The new plan, or null when the run may not create another category.
 */
function newPlanFor(
  proposal: CategoryProposal,
  key: string,
  planned: Map<string, PlannedCategory>,
  counts: CategoryAssignmentCounts,
): PlannedCategory | null {
  if (countNew(planned) >= MAX_NEW_CATEGORIES_PER_RUN) {
    counts.truncated["new-category-cap"] += 1;
    return null;
  }
  const plan: PlannedCategory = {
    existing: null,
    canonicalName: proposal.canonicalName,
    description: proposal.description,
    inclusionCriterion: proposal.inclusionCriterion,
    members: [],
    dirty: true,
  };
  planned.set(key, plan);
  return plan;
}

/** How many categories this run has decided to create so far. */
function countNew(planned: Map<string, PlannedCategory>): number {
  let total = 0;
  for (const plan of planned.values()) if (plan.existing === null) total += 1;
  return total;
}

/**
 * Record one membership, unless the page is already a member.
 *
 * A page already in the category keeps the reason recorded when it was first admitted:
 * that entry is evidence of what justified it THEN, and re-stating it on every run
 * would churn the file for no new information.
 *
 * @param plan - The category the article belongs to.
 * @param article - The article being added.
 * @param reason - Why it belongs, as the model justified it.
 * @param term - The criterion term the article really mentions.
 * @param counts - Totals to fill.
 */
function addMember(
  plan: PlannedCategory,
  article: CategoryAssignmentArticle,
  reason: string,
  term: string,
  counts: CategoryAssignmentCounts,
): void {
  const pageId = `concepts/${article.slug}`;
  if (plan.members.some((member) => member.pageId === pageId)) return;
  plan.members.push({ pageId, reason, evidenceKey: evidenceKeyFor(term) });
  plan.dirty = true;
  counts.assigned += 1;
}

/**
 * Write every planned category through the store, in id order.
 *
 * Only a plan whose member set really grew is written, so a second run that assigns
 * nothing touches no file. A refused write is counted and warned: the run must not
 * claim a category it did not store.
 *
 * @param root - Project root the writes are confined under.
 * @param planned - The categories this run assembled.
 * @param counts - Totals to fill with what committed.
 * @param options - Where the writes go.
 */
async function flushCategories(
  root: string,
  planned: Map<string, PlannedCategory>,
  counts: CategoryAssignmentCounts,
  options: CategoryAssignmentOptions,
): Promise<void> {
  const plans = [...planned.values()].filter((plan) => plan.dirty).sort(byCategoryId);
  for (const plan of plans) {
    const committed = await commitCategory(root, plan, options);
    if (committed === null) {
      counts.writeFailed += 1;
      continue;
    }
    if (plan.existing === null) counts.created += 1;
    else counts.updated += 1;
    counts.categories += 1;
  }
}

/**
 * Create or update ONE planned category.
 *
 * @param root - Project root.
 * @param plan - The category to store.
 * @param options - Where the write goes, and whether the lock is already held.
 * @returns The stored object id, or null when the write was refused.
 */
async function commitCategory(
  root: string,
  plan: PlannedCategory,
  options: CategoryAssignmentOptions,
): Promise<string | null> {
  try {
    const stored = plan.existing === null
      ? await createCategory(root, {
        canonicalName: plan.canonicalName,
        description: plan.description,
        inclusionCriterion: plan.inclusionCriterion,
        members: plan.members,
      }, options)
      : await updateCategory(root, plan.existing.categoryId, { members: plan.members }, options);
    return stored.objectId;
  } catch (error) {
    output.status("!", output.warn(
      `Category write skipped for "${plan.canonicalName}" — ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
}

/** Order two plans by the id they write to, so the run's writes are deterministic. */
function byCategoryId(left: PlannedCategory, right: PlannedCategory): number {
  const leftId = left.existing?.categoryId ?? canonicalConceptKey(left.canonicalName);
  const rightId = right.existing?.categoryId ?? canonicalConceptKey(right.canonicalName);
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}
