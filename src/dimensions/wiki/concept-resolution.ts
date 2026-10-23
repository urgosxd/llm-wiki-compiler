/**
 * @file src/dimensions/wiki/concept-resolution.ts
 * @description Tier 2 of wiki concept identity: grouping candidates by cosine
 * similarity, with two thresholds.
 *
 * Why two thresholds instead of one: the two mistakes do not cost the same. A
 * false split produces two pages that a reader can see and a later compile can
 * fix. A false merge is irreversible and silent — the distinction between two
 * concepts is gone, the page slug points at a title nobody chose, and nothing in
 * the output says it happened.
 *
 * So a score at or above {@link DEFAULT_AUTO_THRESHOLD} merges outright, while a
 * score in the band down to {@link DEFAULT_REVIEW_THRESHOLD} merges AND is
 * reported as a pending alias, which keeps the uncertain decision visible and
 * reversible. Below the review threshold the concepts stay separate.
 *
 * Two invariants this module guarantees:
 *
 *   - **Order independence.** The same candidates produce the same groups
 *     regardless of input order. `mergeExtractions` iterates sources in a fixed
 *     order (`src/compiler/extraction-phase.ts:41`), so order-dependent resolution
 *     would make two identical compiles produce different pages.
 *   - **Deterministic tie-breaking.** The canonical name is chosen by incumbency,
 *     then confidence, then name — never by arrival.
 *
 * The set bookkeeping lives in `concept-forest.ts`; this module is the policy.
 */

import { cosineSimilarity } from "../../utils/embeddings-search.js";
import { slugify } from "../../utils/markdown.js";
import {
  canonicalConceptKey,
  sharesBlockingSignal,
  tagsConflict,
} from "./concept-identity.js";
import {
  createConceptForest,
  groupsByRoot,
  tierOfRoot,
  unionCandidates,
  type ConceptForest,
} from "./concept-forest.js";

/**
 * A score at or above this merges without review.
 *
 * Conservative on purpose: names and short summaries embed into a narrow cone
 * where unrelated concepts routinely clear 0.85, and a false merge is
 * irreversible. Calibrate against a hand-labelled hold-out, never by intuition.
 */
export const DEFAULT_AUTO_THRESHOLD = 0.92;

/**
 * A score at or above this merges, but the merge is recorded as pending so the
 * uncertain band stays reversible.
 */
export const DEFAULT_REVIEW_THRESHOLD = 0.86;

/** How a group's members were decided to be the same concept. */
export type MergeTier = "slug" | "normalized" | "auto" | "review";

/** One extracted concept, reduced to what identity resolution needs. */
export interface ConceptCandidate {
  readonly name: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly confidence?: number;
}

/** Candidates resolved to one concept. */
export interface ConceptGroup {
  /** Name that survives the merge; every other member becomes an alias of it. */
  readonly canonicalName: string;
  /** Every candidate in this group, including the canonical one. */
  readonly members: readonly ConceptCandidate[];
  /** Strongest evidence that joined this group. */
  readonly tier: MergeTier;
}

/** One merged-away name and the canonical name it resolved to. */
export interface ConceptAlias {
  readonly aliasSlug: string;
  readonly canonicalSlug: string;
  /** Evidence tier that produced this alias. */
  readonly tier: MergeTier;
  /** Cosine score, or `undefined` for a deterministic tier. */
  readonly score?: number;
}

/** Why semantic grouping did not run. */
export interface ConceptDegradation {
  readonly reason: "embeddings-disabled" | "embeddings-unconfigured" | "embeddings-failed";
  readonly detail: string;
}

/**
 * A scoring attempt's outcome.
 *
 * Failure is a value, not an exception: semantic grouping is an enhancement, so a
 * dead provider must leave the deterministic tiers intact and be REPORTED. Modeling
 * it in the type is what stops a caller from catching it and forgetting to say so.
 */
export type ConceptEmbedOutcome =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | { readonly ok: false; readonly degradation: ConceptDegradation };

/** Port the resolver needs for scoring; keeps provider concerns out of it. */
export interface ConceptEmbeddingPort {
  /** Identity of the embedding configuration — see the alias record's use. */
  readonly fingerprint: string;
  /** One vector per input text, in input order. */
  embed(texts: readonly string[]): Promise<ConceptEmbedOutcome>;
}

/** Two thresholds, plus the names already present in the wiki. */
export interface ConceptResolutionOptions {
  readonly embed?: ConceptEmbeddingPort;
  readonly thresholds?: { readonly auto: number; readonly review: number };
  /** Slugs already present in the wiki; these names win the canonical slot. */
  readonly incumbents?: ReadonlySet<string>;
}

/** The full result of one resolution run. */
export interface ConceptResolution {
  readonly groups: readonly ConceptGroup[];
  /** Aliases merged with confident evidence or deterministically. */
  readonly aliases: readonly ConceptAlias[];
  /** Aliases merged inside the review band; reversible by construction. */
  readonly pending: readonly ConceptAlias[];
  readonly degradation?: ConceptDegradation;
}

/**
 * Total order over names, independent of the host locale.
 *
 * `localeCompare` is deliberately NOT used: its result depends on the ICU data and
 * default locale of the machine, so two compiles of the same sources on different
 * hosts could pick a different canonical name and therefore a different page slug.
 * Reproducibility of the wiki is worth more than locale-correct collation here.
 */
function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The deterministic tier for one pair, or `undefined` when only embeddings can
 * decide.
 *
 * The `slug` tier compares SLUGS, not raw names: `slugify` is the compiler's
 * existing identity, so two names that share a slug were already one concept to
 * every other part of the pipeline. The `normalized` tier then covers what the slug
 * cannot fold — acronyms and plurals.
 *
 * Order matters: a pair resolved here needs no similarity call at all, which is
 * what keeps the common case free.
 */
function deterministicTier(left: string, right: string): MergeTier | undefined {
  if (slugify(left) === slugify(right)) {
    return "slug";
  }
  if (canonicalConceptKey(left) === canonicalConceptKey(right)) {
    return "normalized";
  }
  return undefined;
}

/** The text actually embedded for one candidate. */
function identityText(candidate: ConceptCandidate): string {
  return [
    candidate.name,
    candidate.summary ?? "",
    (candidate.tags ?? []).join(", "),
  ].join("\n");
}

/** Whether a pair is eligible for a cosine comparison at all. */
function isComparable(left: ConceptCandidate, right: ConceptCandidate): boolean {
  if (tagsConflict(left.tags, right.tags)) {
    return false;
  }
  return sharesBlockingSignal(left.name, left.tags, right.name, right.tags);
}

/** Applies the deterministic tiers and returns the pairs left for cosine. */
function applyDeterministicTiers(
  ordered: readonly ConceptCandidate[],
  forest: ConceptForest,
): Array<readonly [number, number]> {
  const undecided: Array<readonly [number, number]> = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const tier = deterministicTier(ordered[left].name, ordered[right].name);
      if (tier !== undefined) {
        unionCandidates(forest, left, right, tier);
        continue;
      }
      if (isComparable(ordered[left], ordered[right])) {
        undecided.push([left, right]);
      }
    }
  }
  return undecided;
}

/** One scoring attempt: the vectors per candidate index, or why there are none. */
interface EmbeddedCandidates {
  readonly vectors: Map<number, readonly number[]>;
  readonly degradation?: ConceptDegradation;
}

/** Embeds every distinct candidate text once and returns the vector per index. */
async function embedCandidates(
  ordered: readonly ConceptCandidate[],
  needed: ReadonlySet<number>,
  port: ConceptEmbeddingPort,
): Promise<EmbeddedCandidates> {
  const indices = [...needed].sort((left, right) => left - right);
  if (indices.length === 0) {
    return { vectors: new Map() };
  }
  const outcome = await port.embed(indices.map((index) => identityText(ordered[index])));
  if (!outcome.ok) {
    return { vectors: new Map(), degradation: outcome.degradation };
  }
  const vectors = new Map<number, readonly number[]>();
  indices.forEach((index, position) => {
    const vector = outcome.vectors[position];
    if (vector !== undefined) {
      vectors.set(index, vector);
    }
  });
  return { vectors };
}

/** Merges one scored pair when the score clears a threshold. */
function applyScore(
  forest: ConceptForest,
  pair: readonly [number, number],
  score: number,
  thresholds: { readonly auto: number; readonly review: number },
): void {
  if (score >= thresholds.auto) {
    unionCandidates(forest, pair[0], pair[1], "auto");
    return;
  }
  if (score >= thresholds.review) {
    unionCandidates(forest, pair[0], pair[1], "review");
  }
}

/**
 * Runs the semantic tier over the pairs the deterministic tiers left undecided.
 *
 * @returns The degradation to report, if the port could not score.
 */
async function applySemanticTier(
  ordered: readonly ConceptCandidate[],
  undecided: ReadonlyArray<readonly [number, number]>,
  forest: ConceptForest,
  options: ConceptResolutionOptions,
  thresholds: { readonly auto: number; readonly review: number },
): Promise<ConceptDegradation | undefined> {
  if (undecided.length === 0) {
    return undefined;
  }
  if (options.embed === undefined) {
    return { reason: "embeddings-unconfigured", detail: "no embedding port supplied" };
  }

  const needed = new Set<number>();
  for (const [left, right] of undecided) {
    needed.add(left);
    needed.add(right);
  }
  const embedded = await embedCandidates(ordered, needed, options.embed);
  for (const pair of undecided) {
    const leftVector = embedded.vectors.get(pair[0]);
    const rightVector = embedded.vectors.get(pair[1]);
    if (leftVector === undefined || rightVector === undefined) {
      continue;
    }
    applyScore(forest, pair, cosineSimilarity([...leftVector], [...rightVector]), thresholds);
  }
  return embedded.degradation;
}

/**
 * The member that keeps its name: an incumbent first, then the most confident,
 * then the lexicographically smallest.
 *
 * A newcomer never displaces an incumbent because the canonical name becomes the
 * page slug; renaming it would break inbound links and orphan the provenance of a
 * page nobody asked to move.
 */
function pickCanonical(
  members: readonly ConceptCandidate[],
  incumbents: ReadonlySet<string> | undefined,
): ConceptCandidate {
  const incumbent = members.find(
    (member) => incumbents?.has(slugify(member.name)) === true,
  );
  if (incumbent !== undefined) {
    return incumbent;
  }
  return [...members].sort((left, right) => {
    const leftConfidence = left.confidence ?? 0;
    const rightConfidence = right.confidence ?? 0;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    return compareNames(left.name, right.name);
  })[0];
}

/** Emits one alias per merged-away member, routing it by its evidence tier. */
function collectAliases(
  members: readonly ConceptCandidate[],
  canonicalName: string,
  tier: MergeTier,
  aliases: ConceptAlias[],
  pending: ConceptAlias[],
): void {
  const canonicalSlug = slugify(canonicalName);
  for (const member of members) {
    if (member.name === canonicalName) {
      continue;
    }
    const alias: ConceptAlias = { aliasSlug: slugify(member.name), canonicalSlug, tier };
    if (tier === "review") {
      pending.push(alias);
      continue;
    }
    aliases.push(alias);
  }
}

/**
 * Resolves a batch of concepts into groups of synonyms.
 *
 * Runs the deterministic tiers first, then compares only the pairs they leave
 * undecided, embedding each distinct candidate text exactly once so the cost is one
 * batch request per compile rather than one request per pair.
 *
 * @param candidates - Every concept extracted in this compile.
 * @param options - Embedding port, thresholds and known incumbents.
 * @returns Groups, confident aliases, review-band aliases, and any degradation.
 */
export async function resolveConceptIdentity(
  candidates: readonly ConceptCandidate[],
  options: ConceptResolutionOptions = {},
): Promise<ConceptResolution> {
  const ordered = [...candidates].sort((left, right) => compareNames(left.name, right.name));
  const forest = createConceptForest(ordered.length);
  const undecided = applyDeterministicTiers(ordered, forest);
  const thresholds = options.thresholds ?? {
    auto: DEFAULT_AUTO_THRESHOLD,
    review: DEFAULT_REVIEW_THRESHOLD,
  };

  const degradation = await applySemanticTier(ordered, undecided, forest, options, thresholds);

  const groups: ConceptGroup[] = [];
  const aliases: ConceptAlias[] = [];
  const pending: ConceptAlias[] = [];

  for (const [root, indices] of groupsByRoot(forest, ordered.length)) {
    const members = indices.map((index) => ordered[index]);
    const canonical = pickCanonical(members, options.incumbents);
    const tier = tierOfRoot(forest, root);
    groups.push({ canonicalName: canonical.name, members, tier });
    collectAliases(members, canonical.name, tier, aliases, pending);
  }

  const resolution: ConceptResolution = { groups, aliases, pending };
  return degradation === undefined ? resolution : { ...resolution, degradation };
}
