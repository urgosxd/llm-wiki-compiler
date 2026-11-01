/**
 * @file src/compiler/identity-stage.ts
 * @description The pipeline stage that applies ONE concept-identity decision to a
 * whole compile run, before anything derives a slug from a concept name.
 *
 * ## Where it sits, and why exactly there
 *
 * It runs after extraction (the concepts are known) and after the page snapshot
 * (which supplies the incumbents), but before page generation and before the
 * progress denominator. Everything downstream — the merge accumulators, the
 * affected-page set, the persisted source state, the extraction snapshot, the page
 * writes — then reads one consistent set of names, because they all slugify the
 * extractions this stage already rewrote.
 *
 * ## Why the incumbents come from the page snapshot
 *
 * The canonical-name rule is "the incumbent survives". That needs the slugs already
 * in the wiki, and the pipeline takes exactly that snapshot a few lines earlier for
 * the journal. Reusing it keeps this stage free of I/O, so it cannot disagree with
 * the snapshot the rest of the run is using.
 */

import { CONCEPTS_DIR } from "../utils/constants.js";
import { conceptEmbeddingPortOrUndefined } from "../dimensions/wiki/concept-embeddings.js";
import {
  bindConceptsToCanonicalNames,
  conceptIdentityDecisions,
  reportConceptIdentity,
  resolveExtractionIdentity,
  supersededPageSlugs,
  type ConceptIdentityDecision,
} from "./extraction-identity.js";
import type { ExtractionResult } from "./deps.js";

/** What the stage decided, for the stages after it. */
export interface ConceptIdentityOutcome {
  /** The run's extractions, carrying canonical concept names. */
  readonly extractions: ExtractionResult[];
  /** Per-concept decisions, in flatten order. */
  readonly decisions: readonly ConceptIdentityDecision[];
  /**
   * Pages whose concept name folded into another group, mapped to the slug that
   * absorbed it.
   *
   * Each of those pages now describes a concept the wiki no longer stores under
   * that name, so a later pass retires it. Left in place, one concept is split
   * across two files — the defect this feature exists to remove.
   */
  readonly superseded: ReadonlyMap<string, string>;
}

/**
 * Read the concept slugs already present from the pipeline's page snapshot.
 *
 * @param pageIds - Namespaced ids such as `wiki/concepts/vector-db`.
 * @returns Just the concept slugs.
 */
function incumbentSlugs(pageIds: ReadonlySet<string>): Set<string> {
  const prefix = `${CONCEPTS_DIR}/`;
  const slugs = new Set<string>();
  for (const id of pageIds) {
    if (id.startsWith(prefix)) slugs.add(id.slice(prefix.length));
  }
  return slugs;
}

/**
 * Resolve, bind and report concept identity for one compile run.
 *
 * Degrades to "every concept keeps its own name" when nothing was extracted: a run
 * with no concepts has no identity to decide, and must not fail for the absence.
 * Why semantic grouping did not run is reported by the resolver rather than
 * swallowed here.
 *
 * @param extractions - This run's extraction results, as extracted.
 * @param pageIds - The pipeline's page-id snapshot, used for incumbency.
 * @returns Canonical-named extractions plus the decisions taken.
 */
export async function applyConceptIdentity(
  extractions: ExtractionResult[],
  pageIds: ReadonlySet<string>,
): Promise<ConceptIdentityOutcome> {
  const plan = await resolveExtractionIdentity(extractions, {
    incumbents: incumbentSlugs(pageIds),
    embed: conceptEmbeddingPortOrUndefined(),
  });
  if (plan === undefined) {
    return { extractions, decisions: [], superseded: new Map() };
  }
  reportConceptIdentity(plan);
  const decisions = conceptIdentityDecisions(extractions, plan);
  // A folded name loses its producer. The guard inside `supersededPageSlugs` is
  // that its slug is not ALSO a group slug: an unrelated concept may legitimately
  // own that page, and retiring it would remove a live concept over a collision.
  const groupSlugs = new Set(decisions.map((decision) => decision.entry.groupSlug));
  return {
    extractions: bindConceptsToCanonicalNames(extractions, plan),
    decisions,
    superseded: supersededPageSlugs(groupSlugs, decisions),
  };
}
