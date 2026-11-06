/**
 * @file src/dimensions/wiki/concept-merge-plan.ts
 * @description The seam the compile calls to learn which extracted concepts are
 * the same concept.
 *
 * Why this exists as a separate module: `concept-resolution.ts` owns the POLICY
 * (which tiers run, in what order, with what thresholds) and knows nothing about
 * the compiler's data shapes. The compile owns `ExtractedConcept`, whose display
 * field is `concept` while the resolver calls it `name`. Without one adapter
 * between them, every caller re-invents the mapping, and the two copies drift the
 * moment either side changes a field.
 *
 * ## What a caller gets
 *
 * A plan, not a resolver result. `ConceptResolution` answers "how were these
 * grouped"; a compiler needs "for each concept I extracted, which group does it
 * belong to, and what should that group be called". Those are different questions
 * and the second one is what `mergeExtractions` has to key its accumulators on.
 *
 * ## Why the representative is a slug
 *
 * The merging accumulator is keyed by slug because that is what a page IS
 * downstream: `slugify` decides the page filename, the inbound links and the
 * `page_chunk_embeddings` primary key. A group's representative is therefore the
 * slug of its canonical name — the one identity that must not change, or the page
 * moves and its inbound links break.
 */

import { slugify } from "../../utils/markdown.js";
import {
  resolveConceptIdentity,
  type ConceptResolution,
  type ConceptResolutionOptions,
  type IdentityTier,
} from "./concept-resolution.js";

/** The minimum a candidate must carry to be resolved; the compiler's shape satisfies it. */
export interface MergePlanCandidate {
  /** Display name of the concept, as the extraction returned it. */
  readonly name: string;
  /** Optional summary; it participates in the identity text used for scoring. */
  readonly summary?: string;
  /** Optional tags; they gate and inform the semantic comparison. */
  readonly tags?: readonly string[];
  /** Optional extraction confidence; it breaks canonical-name ties. */
  readonly confidence?: number;
  /** Other names this concept is already known by; they drive the `alias` tier. */
  readonly aliases?: readonly string[];
}

/** Where one candidate landed, and what the group it joined is called. */
export interface MergePlanEntry {
  /** Group this candidate belongs to: the slug of the group's canonical name. */
  readonly groupSlug: string;
  /** Display name that survives the merge for this group. */
  readonly canonicalName: string;
  /** True for the one candidate whose own name became `canonicalName`. */
  readonly isCanonical: boolean;
  /** Deterministic evidence the group rests on: `slug`, `normalized` or `alias`. */
  readonly tier: IdentityTier;
}

/** The full answer: one entry per input candidate, in input order. */
export interface ConceptMergePlan {
  /** One entry per input candidate, positionally aligned with the input array. */
  readonly entries: readonly MergePlanEntry[];
  /** The resolver's own result, for callers that need tiers or pending aliases. */
  readonly resolution: ConceptResolution;
}

/** Resolve a group's canonical name to the slug that identifies the group. */
function groupSlugFor(canonicalName: string): string {
  return slugify(canonicalName);
}

/**
 * Build the positional plan for one resolved group.
 *
 * Matching is by NAME, not by index, because `resolveConceptIdentity` sorts its
 * input before grouping: the resolver's member order is deterministic but it is
 * NOT the caller's input order, and conflating the two would hand a caller the
 * wrong group for its concept.
 *
 * @param group - The resolved group, as the resolver ordered it.
 * @returns One plan entry per member.
 */
function planForGroup(group: ConceptResolution["groups"][number]): Map<string, MergePlanEntry> {
  const groupSlug = groupSlugFor(group.canonicalName);
  const plan = new Map<string, MergePlanEntry>();
  for (const member of group.members) {
    plan.set(member.name, {
      groupSlug,
      canonicalName: group.canonicalName,
      isCanonical: member.name === group.canonicalName,
      tier: group.tier,
    });
  }
  return plan;
}

/**
 * Flatten the resolution into a name-keyed lookup of plan entries.
 *
 * @param resolution - The resolver's result.
 * @returns Every candidate's plan entry, keyed by its display name.
 */
function byCandidateName(resolution: ConceptResolution): Map<string, MergePlanEntry> {
  const lookup = new Map<string, MergePlanEntry>();
  for (const group of resolution.groups) {
    for (const [name, entry] of planForGroup(group)) {
      lookup.set(name, entry);
    }
  }
  return lookup;
}

/**
 * A conservative entry for a candidate the resolver did not group.
 *
 * Unreachable while the resolver groups every input, and kept so that a future
 * resolver that drops a malformed candidate degrades to "this concept stands
 * alone" instead of throwing inside the page-generation stage.
 */
function soloEntry(name: string): MergePlanEntry {
  return { groupSlug: groupSlugFor(name), canonicalName: name, isCanonical: true, tier: "slug" };
}

/**
 * Resolve extracted concepts into the merge plan the compile consumes.
 *
 * Positionally aligned: `entries[i]` describes `candidates[i]`. Callers that key
 * accumulators by name can use {@link indexByName}; callers that walk their own
 * extraction array use the entries directly.
 *
 * @param candidates - Every concept extracted in this compile.
 * @param options - Embedding port, thresholds and known incumbents.
 * @returns The positional plan plus the resolver's full result.
 */
export async function planConceptMerge(
  candidates: readonly MergePlanCandidate[],
  options: ConceptResolutionOptions = {},
): Promise<ConceptMergePlan> {
  const resolution = await resolveConceptIdentity(candidates, options);
  const lookup = byCandidateName(resolution);
  const entries = candidates.map((candidate) => lookup.get(candidate.name) ?? soloEntry(candidate.name));
  return { entries, resolution };
}

/**
 * Group slugs in a stable order, for callers that need a deterministic page set.
 *
 * @param plan - A merge plan.
 * @returns The distinct group slugs, sorted.
 */
export function groupSlugs(plan: ConceptMergePlan): string[] {
  return [...new Set(plan.entries.map((entry) => entry.groupSlug))].sort();
}
