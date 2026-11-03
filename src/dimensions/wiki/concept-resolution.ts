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
 * ## Tier order: slug, then similarity, then rules
 *
 * The semantic tier runs ABOVE the deterministic one. Exact-slug equality still
 * decides first because it is free and already the compiler's notion of identity,
 * but everything the slug leaves open is offered to the cosine score before the
 * normalization rules see it. The rules then settle only what the score could not
 * decide — or everything, when no embedding port is usable at all.
 *
 * This is deliberately NOT "rules first, similarity for the leftovers". A rule can
 * only fold spellings someone thought to enumerate, so rules-first makes the
 * synonym set the ceiling of what the wiki can ever merge. Similarity-first makes
 * the rules a safety net instead of the authority.
 *
 * The cost of that ordering is why {@link MAX_SEMANTIC_PAIRS} exists: see
 * {@link applySemanticTier}.
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
  tierThatJoined,
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
  /**
   * Evidence tier of the edge that absorbed THIS alias — not the group's strongest
   * tier. Routing an alias to the confident or the pending band by the group's best
   * evidence would promote a review-band merge to an irreversible one.
   */
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

/**
 * Pair budget for the semantic tier: beyond this, the blocking gate is re-armed.
 *
 * Cosine-first means every pair the slug left open is a candidate, which is
 * quadratic in the candidate count. At 768 dimensions a full sweep is cheap for
 * hundreds of concepts and untenable for thousands, so past this budget the
 * resolver falls back to comparing only pairs that share a blocking token. That
 * keeps the common case exact and the pathological case bounded without ever
 * silently doing nothing.
 */
const MAX_SEMANTIC_PAIRS = 20_000;

/**
 * Whether a pair is eligible for a cosine comparison at all.
 *
 * `tagsConflict` is a HARD exclusion: a disjoint tag set is positive evidence that
 * two concepts differ, so it outranks any score.
 *
 * The blocking token is a SOFT gate and is off by default, because requiring a
 * shared token excludes exactly the pairs the semantic tier exists to find: a
 * synonym that shares no word — "PostgreSQL" against "Postgres", "k8s" against
 * "Kubernetes" — has no blocking signal by construction. Requiring one made the
 * tier unable to earn its position above the rules.
 */
function isComparable(
  left: ConceptCandidate,
  right: ConceptCandidate,
  requireBlockingSignal: boolean,
): boolean {
  if (tagsConflict(left.tags, right.tags)) {
    return false;
  }
  if (!requireBlockingSignal) {
    return true;
  }
  return sharesBlockingSignal(left.name, left.tags, right.name, right.tags);
}

/** Applies the exact-slug tier and returns the pairs it left undecided. */
function applySlugTier(
  ordered: readonly ConceptCandidate[],
  forest: ConceptForest,
): Array<readonly [number, number]> {
  const undecided: Array<readonly [number, number]> = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      if (slugify(ordered[left].name) === slugify(ordered[right].name)) {
        unionCandidates(forest, left, right, "slug");
        continue;
      }
      undecided.push([left, right]);
    }
  }
  return undecided;
}

/**
 * Applies the normalization rules to whichever pairs are still undecided.
 *
 * This is the LAST tier: it only runs where the score could not decide, and it runs
 * on every remaining pair when the semantic tier never ran at all.
 */
function applyRuleTier(
  ordered: readonly ConceptCandidate[],
  forest: ConceptForest,
  pairs: ReadonlyArray<readonly [number, number]>,
  decided: ReadonlySet<string>,
): void {
  for (const [left, right] of pairs) {
    if (decided.has(pairKey(left, right))) {
      continue;
    }
    const tier = deterministicTier(ordered[left].name, ordered[right].name);
    if (tier !== undefined) {
      unionCandidates(forest, left, right, tier);
    }
  }
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

/** What the semantic tier concluded, and which pairs it is therefore responsible for. */
interface SemanticOutcome {
  readonly degradation?: ConceptDegradation;
  /**
   * Pairs this tier actually scored.
   *
   * Load-bearing: the rule tier must NOT revisit them. A rule re-joining a pair the
   * score already merged only overwrites that group's evidence with a lower rank,
   * which reports the merge as `normalized` and hands the authority back to the
   * rules — the exact inversion this tier order exists to prevent.
   */
  readonly decided: ReadonlySet<string>;
}

/** Stable key for one unordered pair of candidate indices. */
function pairKey(left: number, right: number): string {
  return `${left}-${right}`;
}

/**
 * Runs the semantic tier over the pairs the exact-slug tier left undecided.
 *
 * @returns The degradation to report, plus the pairs this tier decided.
 */
async function applySemanticTier(
  ordered: readonly ConceptCandidate[],
  undecided: ReadonlyArray<readonly [number, number]>,
  forest: ConceptForest,
  options: ConceptResolutionOptions,
  thresholds: { readonly auto: number; readonly review: number },
): Promise<SemanticOutcome> {
  if (undecided.length === 0) {
    return { decided: new Set() };
  }
  if (options.embed === undefined) {
    return {
      decided: new Set(),
      degradation: { reason: "embeddings-unconfigured", detail: "no embedding port supplied" },
    };
  }

  const pairs = semanticPairs(ordered, undecided);
  if (pairs.length === 0) {
    return { decided: new Set() };
  }
  const needed = new Set<number>();
  for (const [left, right] of pairs) {
    needed.add(left);
    needed.add(right);
  }
  const embedded = await embedCandidates(ordered, needed, options.embed);
  const decided = new Set<string>();
  for (const pair of pairs) {
    const leftVector = embedded.vectors.get(pair[0]);
    const rightVector = embedded.vectors.get(pair[1]);
    if (leftVector === undefined || rightVector === undefined) {
      continue;
    }
    // Scored, therefore this tier owns the verdict: even a score BELOW the review
    // band is a decision ("different"), and the rules are not allowed to override it.
    decided.add(pairKey(pair[0], pair[1]));
    applyScore(forest, pair, cosineSimilarity([...leftVector], [...rightVector]), thresholds);
  }
  return { decided, degradation: embedded.degradation } as SemanticOutcome;
}

/**
 * The pairs the semantic tier will actually score, after the tag gate and the
 * budget.
 *
 * Under the budget every pair is a candidate, so a synonym that shares no word is
 * still compared. Over it, the blocking gate is re-armed to keep the sweep affine
 * instead of quadratic — a bounded answer rather than an unbounded bill.
 *
 * @param ordered - Candidates in deterministic order.
 * @param undecided - Pairs the exact-slug tier left open.
 * @returns The pairs to score.
 */
function semanticPairs(
  ordered: readonly ConceptCandidate[],
  undecided: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
  const requireBlockingSignal = undecided.length > MAX_SEMANTIC_PAIRS;
  return undecided.filter(([left, right]) =>
    isComparable(ordered[left], ordered[right], requireBlockingSignal),
  );
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

/**
 * Emits one alias per merged-away member, each routed by the evidence that joined
 * THAT member.
 *
 * The tier is read per member rather than taken once for the group. In a group where
 * A-B merged at `auto` and B-C only at `review`, C is held in the pending band while
 * B stays confident; using the group's strongest tier would emit C as a confident,
 * irreversible alias and silently collapse the review band for every member that
 * joined through a weak edge.
 *
 * The canonical member is skipped: it absorbed nothing, so it owes no alias.
 *
 * @param members - One entry per group member, pairing the candidate with its GLOBAL
 *   forest index. The two index spaces differ: `members` is local to the group while
 *   the forest is addressed globally, and conflating them reads the wrong node's
 *   evidence.
 * @param canonicalName - Name of the member that keeps the group's identity.
 */
function collectAliases(
  members: ReadonlyArray<{ readonly index: number; readonly candidate: ConceptCandidate }>,
  canonicalName: string,
  forest: ConceptForest,
  aliases: ConceptAlias[],
  pending: ConceptAlias[],
): void {
  const canonicalSlug = slugify(canonicalName);
  for (const { index, candidate } of members) {
    if (candidate.name === canonicalName) {
      continue;
    }
    const tier = tierThatJoined(forest, index);
    const alias: ConceptAlias = {
      aliasSlug: slugify(candidate.name),
      canonicalSlug,
      tier,
    };
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
  const thresholds = options.thresholds ?? {
    auto: DEFAULT_AUTO_THRESHOLD,
    review: DEFAULT_REVIEW_THRESHOLD,
  };

  // Tier order is load-bearing: exact slug, then similarity, then rules. The score
  // must see every pair the slug left open, and the rules must see whatever the
  // score left open — including the case where the score never ran.
  const bySlug = applySlugTier(ordered, forest);
  const semantic = await applySemanticTier(ordered, bySlug, forest, options, thresholds);
  applyRuleTier(ordered, forest, bySlug, semantic.decided);
  const degradation = semantic.degradation;

  const groups: ConceptGroup[] = [];
  const aliases: ConceptAlias[] = [];
  const pending: ConceptAlias[] = [];

  for (const [root, indices] of groupsByRoot(forest, ordered.length)) {
    const entries = indices.map((index) => ({ index, candidate: ordered[index] }));
    const canonical = pickCanonical(
      entries.map((entry) => entry.candidate),
      options.incumbents,
    );
    groups.push({
      canonicalName: canonical.name,
      members: entries.map((entry) => entry.candidate),
      tier: tierOfRoot(forest, root),
    });
    collectAliases(entries, canonical.name, forest, aliases, pending);
  }

  const resolution: ConceptResolution = { groups, aliases, pending };
  return degradation === undefined ? resolution : { ...resolution, degradation };
}
