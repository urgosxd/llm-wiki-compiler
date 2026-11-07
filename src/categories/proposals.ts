/**
 * @file Reading the category-assignment answer: what the model proposed, validated.
 *
 * ## The model proposes, this module decides what is even a proposal
 *
 * The tool schema asks for four fields per category plus the reason the CURRENT page
 * belongs. A schema is a request, not a guarantee, so every field is validated here
 * and a proposal that fails is REFUSED with a named reason instead of being completed
 * with a default:
 *
 *  - `incomplete` — one of the four required attributes (canonical name, description,
 *    inclusion criterion) or the member's reason is missing or blank;
 *  - `uncheckable` — the criterion quotes no term, so nothing could ever test whether a
 *    page belongs (see `criteria.ts`);
 *  - `supported` is decided by the caller, which is the only layer that holds the
 *    article's text: a criterion the article itself does not satisfy describes a
 *    category this page is not in;
 *  - `unreadable` — the whole answer could not be parsed, which is a different fact
 *    from any per-proposal refusal and is counted separately.
 *
 * Every reason is countable, and the compile reports the counts. A run that silently
 * dropped a model's proposal would be indistinguishable from a run whose model gave up.
 */

import { CategoryValidationError } from "./types.js";
import { requireText } from "./validation.js";
import { criterionTerms } from "./criteria.js";

/** The fields a REFUSED proposal can be refused for. */
export type ProposalRefusal = "incomplete" | "uncheckable" | "unsupported" | "unreadable";

/** Every refusal reason, so a caller can iterate them without restating the union. */
export const PROPOSAL_REFUSALS: readonly ProposalRefusal[] = [
  "incomplete",
  "uncheckable",
  "unsupported",
  "unreadable",
];

/** One complete, checkable category proposal for one article. */
export interface CategoryProposal {
  /** The name a reader would see; reuse of an existing category is matched on it. */
  canonicalName: string;
  /** What the category is about. Required. */
  description: string;
  /** The rule that decides membership, quoting its checkable terms. Required. */
  inclusionCriterion: string;
  /** Why THIS article belongs. Becomes the member entry's reason. Required. */
  reason: string;
  /** The quoted terms of {@link inclusionCriterion}, extracted once here. */
  terms: string[];
}

/**
 * Parse the tool answer into its raw proposal list.
 *
 * @param toolOutput - Raw JSON string returned from the assign_categories tool.
 * @returns The raw proposals in the order the model offered them, or null when the
 *   answer cannot be read as a proposal list at all.
 */
export function parseCategoryProposals(toolOutput: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(toolOutput);
    if (typeof parsed !== "object" || parsed === null) return null;
    const categories = (parsed as { categories?: unknown }).categories;
    if (categories === undefined) return null;
    return Array.isArray(categories) ? categories : null;
  } catch {
    return null;
  }
}

/**
 * Validate raw proposals, refusing the ones that are not usable proposals at all.
 *
 * @param raw - The raw list from {@link parseCategoryProposals}.
 * @param refused - Counts to fill, one per refused proposal.
 * @returns The complete proposals, in the model's order.
 */
export function readProposals(
  raw: readonly unknown[],
  refused: Record<ProposalRefusal, number>,
): CategoryProposal[] {
  const proposals: CategoryProposal[] = [];
  for (const entry of raw) {
    const proposal = readProposal(entry, refused);
    if (proposal !== null) proposals.push(proposal);
  }
  return proposals;
}

/**
 * Validate one raw proposal.
 *
 * @param entry - One element of the tool answer's `categories` list.
 * @param refused - Counts to fill when the proposal is refused.
 * @returns The complete proposal, or null when it was refused.
 */
function readProposal(
  entry: unknown,
  refused: Record<ProposalRefusal, number>,
): CategoryProposal | null {
  const fields = requireFields(entry);
  if (fields === null) {
    refused.incomplete += 1;
    return null;
  }
  const terms = criterionTerms(fields.inclusionCriterion);
  if (terms.length === 0) {
    refused.uncheckable += 1;
    return null;
  }
  return { ...fields, terms };
}

/** The four required proposal fields, or null when one of them is missing. */
function requireFields(entry: unknown): Omit<CategoryProposal, "terms"> | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  try {
    return {
      canonicalName: requireText(raw.canonical_name, "canonicalName"),
      description: requireText(raw.description, "description"),
      inclusionCriterion: requireText(raw.inclusion_criterion, "inclusionCriterion"),
      reason: requireText(raw.reason, "memberReason"),
    };
  } catch (error) {
    // A typed refusal is the expected shape; anything else is a bug worth seeing.
    if (error instanceof CategoryValidationError) return null;
    throw error;
  }
}
