/**
 * @file src/compiler/extraction-identity.ts
 * @description Binds a compile's extractions to ONE concept-identity decision,
 * so every stage that names a concept agrees on what it is called.
 *
 * ## Why this is not done inside `mergeExtractions`
 *
 * A concept's slug is not a rendering detail: it is the page filename, the
 * `page_chunk_embeddings` primary key, the link target, and the unit of
 * ownership persisted in source state. Six separate places derive it —
 * `affectedPageSlugs`, the merge accumulators, `SourceState.concepts`, the
 * extraction-reuse snapshot, frozen/reconciliation bookkeeping, and the page
 * write itself.
 *
 * Folding synonyms only inside the merge would write the page under the
 * canonical slug while ownership still recorded the alias. The next run would
 * then schedule the wrong owners, lose the alias's evidence silently, and leave
 * the alias page on disk claiming to be its own concept. So the resolution
 * happens ONCE, before any of those consumers runs, and its answer is applied to
 * the extractions themselves: after {@link bindConceptsToCanonicalNames}, a
 * merged-away name no longer exists in the run, and every downstream `slugify`
 * therefore lands on the canonical slug for free.
 *
 * ## Positional, never name-keyed
 *
 * Two extractions of the same document can both yield "Vector DB" with different
 * summaries. Keying a lookup by name would collapse them into one entry and hand
 * the second the first one's group. `planConceptMerge` guarantees
 * position-by-position alignment with the flattened input, so this module walks
 * the extractions and the plan with a single cursor and refuses to run if the
 * two sequences ever disagree on length.
 */

import { slugify } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import {
  planConceptMerge,
  type ConceptMergePlan,
  type MergePlanCandidate,
  type MergePlanEntry,
} from "../dimensions/wiki/concept-merge-plan.js";
import {
  DEFAULT_PROPOSAL_THRESHOLD,
  type ConceptEmbeddingPort,
  type ConceptIncumbentSnapshot,
  type ConceptSimilarity,
} from "../dimensions/wiki/concept-resolution.js";
import type { ExtractedConcept } from "../utils/types.js";
import type { ExtractionResult } from "./deps.js";

/** One extracted concept with the name it was extracted under and its group. */
export interface ConceptIdentityDecision {
  /** Name exactly as the extraction returned it. */
  readonly extractedName: string;
  /** Where the resolver put it. */
  readonly entry: MergePlanEntry;
}

/**
 * Everything the resolver needs and knows about this run.
 *
 * Grouped into one object instead of positional arguments because the two are
 * unrelated facts that a caller can easily swap.
 */
export interface ConceptIdentityOptions {
  /** Existing concept pages, with the names and aliases they already answer to. */
  readonly incumbents?: ConceptIncumbentSnapshot;
  /** Embedding port for similarity proposals, when one is available. */
  readonly embed?: ConceptEmbeddingPort;
}

/** Map one extracted concept onto the resolver's candidate shape. */
function toMergePlanCandidate(concept: ExtractedConcept): MergePlanCandidate {
  return {
    name: concept.concept,
    summary: concept.summary,
    ...(concept.tags === undefined ? {} : { tags: concept.tags }),
    ...(concept.confidence === undefined ? {} : { confidence: concept.confidence }),
  };
}

/**
 * Flatten every extraction into the candidate list the resolver consumes.
 *
 * Order is source order, then the extraction's own concept order — the same
 * order `mergeExtractions` walks. The planner's entries are aligned to it.
 *
 * @param extractions - This run's extraction results.
 * @returns One candidate per extracted concept, in flatten order.
 */
export function mergePlanCandidates(
  extractions: readonly ExtractionResult[],
): MergePlanCandidate[] {
  const candidates: MergePlanCandidate[] = [];
  for (const result of extractions) {
    for (const concept of result.concepts) {
      candidates.push(toMergePlanCandidate(concept));
    }
  }
  return candidates;
}

/**
 * Resolve this run's concept identity exactly once.
 *
 * Pure with respect to disk: it reads no files and writes no state, so calling it
 * before the write phase is safe and its answer can be reused by every consumer.
 *
 * @param extractions - This run's extraction results.
 * @param options - Incumbent slugs and the optional embedding port.
 * @returns The positional plan, or `undefined` when nothing was extracted.
 */
export async function resolveExtractionIdentity(
  extractions: readonly ExtractionResult[],
  options: ConceptIdentityOptions = {},
): Promise<ConceptMergePlan | undefined> {
  const candidates = mergePlanCandidates(extractions);
  if (candidates.length === 0) {
    return undefined;
  }
  return await planConceptMerge(candidates, {
    ...(options.incumbents === undefined ? {} : { incumbents: options.incumbents }),
    ...(options.embed === undefined ? {} : { embed: options.embed }),
  });
}

/**
 * Pair every extracted concept with the plan entry that describes it.
 *
 * @param extractions - The same results the plan was built from, unmodified.
 * @param plan - The plan `planConceptMerge` produced for them.
 * @returns One decision per extracted concept, in flatten order.
 * @throws When the two sequences disagree on length, which would silently bind a
 *   concept to another concept's group.
 */
export function conceptIdentityDecisions(
  extractions: readonly ExtractionResult[],
  plan: ConceptMergePlan,
): ConceptIdentityDecision[] {
  const candidates = mergePlanCandidates(extractions);
  if (plan.entries.length !== candidates.length) {
    throw new Error(
      `concept identity plan covers ${plan.entries.length} concepts but the run extracted ${candidates.length}`,
    );
  }
  return candidates.map((candidate, index) => ({
    extractedName: candidate.name,
    entry: plan.entries[index],
  }));
}

/**
 * Apply the plan's canonical names to the extractions.
 *
 * A merged-away concept keeps its evidence (summary, tags, confidence,
 * contradictions) and takes the group's canonical name, which is what makes every
 * downstream `slugify` land on the canonical slug without a second lookup table.
 * Its `is_new` is forced false: the model reported that ITS name was new, but the
 * page it now belongs to is the canonical one, and that record decides.
 *
 * @param extractions - This run's extraction results.
 * @param plan - The plan built from those same results.
 * @returns New extraction results; the inputs are not mutated.
 */
export function bindConceptsToCanonicalNames(
  extractions: readonly ExtractionResult[],
  plan: ConceptMergePlan,
): ExtractionResult[] {
  const decisions = conceptIdentityDecisions(extractions, plan);
  let cursor = 0;
  return extractions.map((result) => ({
    ...result,
    concepts: result.concepts.map((concept) => {
      const entry = decisions[cursor].entry;
      cursor += 1;
      if (entry.isCanonical) {
        return concept;
      }
      return { ...concept, concept: entry.canonicalName, is_new: false };
    }),
  }));
}

/**
 * Pages that move because their concept name folded into another group.
 *
 * The authoritative page set is the merged concepts, which already carry
 * canonical slugs. A name that reached a page under its own slug now has a page
 * no stage will regenerate, and leaving it there splits one concept across two
 * files — the exact defect this feature exists to remove.
 *
 * @param pageSlugs - Slugs the merged page set will write.
 * @param decisions - The plan's per-concept decisions.
 * @returns Old slug → new slug, only for names that actually moved.
 */
export function supersededPageSlugs(
  pageSlugs: ReadonlySet<string>,
  decisions: readonly ConceptIdentityDecision[],
): Map<string, string> {
  const superseded = new Map<string, string>();
  for (const { extractedName, entry } of decisions) {
    if (entry.isCanonical) continue;
    const aliasSlug = slugify(extractedName);
    if (aliasSlug === entry.groupSlug || pageSlugs.has(aliasSlug)) continue;
    superseded.set(aliasSlug, entry.groupSlug);
  }
  return superseded;
}

/**
 * The names that folded into each concept page, keyed by that page's slug.
 *
 * This is what makes a merge STICK: the surviving page records every name that
 * resolved to it, so the next ingest folds those names deterministically instead of
 * re-deciding them from a similarity score. Derived here, once, from the decisions
 * the run actually took — the page renderer only formats it.
 *
 * @param decisions - The plan's per-concept decisions, in flatten order.
 * @returns Group slug → the folded-away names, in flatten order, deduplicated.
 */
export function foldedNamesByGroupSlug(
  decisions: readonly ConceptIdentityDecision[],
): Map<string, string[]> {
  const folded = new Map<string, string[]>();
  for (const { extractedName, entry } of decisions) {
    if (entry.isCanonical) continue;
    const names = folded.get(entry.groupSlug) ?? [];
    if (!names.includes(extractedName)) {
      names.push(extractedName);
    }
    folded.set(entry.groupSlug, names);
  }
  return folded;
}

/**
 * The line that reports one similarity proposal to the user.
 *
 * Named and exported so the wording is testable without capturing stdout. It has to
 * say three things: which two concepts look close, HOW close, and that they were NOT
 * merged — otherwise a reader would take the number as a decision somebody took.
 *
 * @param similarity - One scored pair no deterministic rule folded.
 * @returns The user-facing warning text, without colour codes.
 */
export function possibleDuplicateWarning(similarity: ConceptSimilarity): string {
  return `Possible duplicate (similarity ${similarity.score.toFixed(2)}): "${similarity.leftName}" and "${similarity.rightName}" look related but were NOT merged — equivalence needs a name or alias match.`;
}

/**
 * Report what identity resolution decided, once per run.
 *
 * Silence is not an option for either half of this report. The degradation explains
 * why no proposals were produced at all; each proposal is printed as a warning so a
 * possible duplicate reaches a human instead of staying inside the result object
 * (S12). The group count is verbose-only, because a normal compile does not need to
 * narrate unchanged behaviour.
 *
 * @param plan - The plan for this run.
 */
export function reportConceptIdentity(plan: ConceptMergePlan): void {
  const folded = plan.entries.filter((entry) => !entry.isCanonical).length;
  if (folded > 0) {
    const groups = new Set(plan.entries.map((entry) => entry.groupSlug)).size;
    output.status("=", output.dim(
      `Concept identity: ${folded} name(s) folded into ${groups} concept page(s).`,
    ));
  }
  const degradation = plan.resolution.degradation;
  if (degradation !== undefined) {
    output.status("!", output.warn(
      `Semantic concept grouping unavailable (${degradation.reason}): ${degradation.detail}`,
    ));
  }
  reportPossibleDuplicates(plan.resolution.similarities);
}

/**
 * Prints one warning per proposal that clears the reporting floor.
 *
 * The floor is cosmetic: pairs below it stay in the resolution data for callers that
 * want them, they are merely not worth a line each in a compile log.
 *
 * @param similarities - Every scored pair the resolver returned.
 */
function reportPossibleDuplicates(similarities: readonly ConceptSimilarity[]): void {
  const reportable = similarities.filter(
    (similarity) => similarity.score >= DEFAULT_PROPOSAL_THRESHOLD,
  );
  for (const similarity of reportable) {
    output.status("!", output.warn(possibleDuplicateWarning(similarity)));
  }
  if (similarities.length > 0) {
    verbose(`similarity proposals: ${reportable.length} of ${similarities.length} pair(s) reported`);
  }
}
