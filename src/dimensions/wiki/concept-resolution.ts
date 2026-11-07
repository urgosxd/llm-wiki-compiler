/**
 * @file src/dimensions/wiki/concept-resolution.ts
 * @description Concept identity for the wiki compile: EQUIVALENCE decides,
 * SIMILARITY only proposes (S6, S14).
 *
 * ## The rule this module enforces
 *
 * Two differently-named candidates become one page only when a deterministic rule
 * proves they are the same referent. Those rules run in one precedence order:
 *
 *   1. `slug` — `slugify(a) === slugify(b)`, the compiler's pre-existing notion of
 *      identity and therefore the cheapest tier.
 *   2. `normalized` — `canonicalConceptKey(a) === canonicalConceptKey(b)`, i.e. the
 *      reviewed plural/acronym rule in `concept-identity.ts`.
 *   3. `alias` — the candidate's name matches one of an incumbent page's declared
 *      `aliases`, or one of the candidate's own aliases matches that incumbent's
 *      canonical name. Compared on canonical keys, never on raw strings.
 *
 * An embedding score is NOT on that list, and no code path here lets one reach group
 * construction: the union-find is only ever fed a name-rule tier, and those tiers are
 * the only ranks it can report. The retrieval port survives as a PROPOSAL channel —
 * pairs no rule folded are scored and returned as {@link ConceptSimilarity} data,
 * which the compile reports as possible duplicates and never acts on. A score of 1.0
 * therefore changes nothing about what a page IS; it only gives a human a lead.
 *
 * ## Why the alias tier is what makes progress possible
 *
 * The rules can only fold spellings somebody enumerated; an alias is the wiki's own
 * record that a name already resolved to a page. Reading it back turns one decided
 * merge into a permanent deterministic rule for every later ingest, instead of
 * re-deciding the same synonym with a cosine score on every compile.
 *
 * ## Determinism
 *
 * The same candidates and incumbents produce the same groups regardless of input
 * order, and the canonical name is chosen by incumbency, then confidence, then
 * code-unit name order — never by arrival and never by locale.
 */

import { cosineSimilarity } from "../../utils/embeddings-search.js";
import { slugify } from "../../utils/markdown.js";
import {
  canonicalConceptKey,
  canonicalSlugKey,
  sharesBlockingSignal,
  tagsConflict,
} from "./concept-identity.js";
import {
  createConceptForest,
  groupsByRoot,
  isDeterministicTier,
  tierOfRoot,
  tierThatJoined,
  unionCandidates,
  type ConceptForest,
} from "./concept-forest.js";

/**
 * The evidence vocabulary of the shared union-find.
 *
 * Only the deterministic name rules are in it. Similarity used to contribute two
 * further ranks -- `auto` and `review` -- which are RETIRED and absent from this
 * type: no path in this module can produce one, and both the union-find (which
 * refuses a rank it does not own) and {@link identityTierOf} (which refuses a rank
 * it cannot map) reject them if an untyped caller ever presents one.
 */
export type MergeTier = "slug" | "normalized";

/** How a group's members were decided to be the same concept. */
export type IdentityTier = "slug" | "normalized" | "alias";

/** One extracted concept, reduced to what identity resolution needs. */
export interface ConceptCandidate {
  readonly name: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly confidence?: number;
  /**
   * Other names this concept is already known by. Matching one of them against an
   * incumbent page folds the candidate into that page at the `alias` tier.
   */
  readonly aliases?: readonly string[];
}

/** Candidates resolved to one concept. */
export interface ConceptGroup {
  /** Name that survives the merge; every other member becomes an alias of it. */
  readonly canonicalName: string;
  /** Every candidate in this group, including the canonical one. */
  readonly members: readonly ConceptCandidate[];
  /** Strongest deterministic evidence that joined this group. */
  readonly tier: IdentityTier;
}

/** One merged-away name and the canonical page it resolved to. */
export interface ConceptAlias {
  readonly aliasSlug: string;
  readonly canonicalSlug: string;
  /** Deterministic evidence of the fold that absorbed THIS name. */
  readonly tier: IdentityTier;
}

/**
 * One scored candidate pair that NO rule folded together.
 *
 * Data, not a verdict: nothing downstream may group by it, rename by it, or write a
 * page because of it. It exists so the compile can tell a user "these look close —
 * you may want to reconcile them yourself".
 */
export interface ConceptSimilarity {
  readonly leftName: string;
  readonly rightName: string;
  /** Cosine similarity in `[-1, 1]`, as the provider's vectors produced it. */
  readonly score: number;
}

/** Why similarity proposals did not run. */
export interface ConceptDegradation {
  readonly reason: "embeddings-disabled" | "embeddings-unconfigured" | "embeddings-failed";
  readonly detail: string;
}

/**
 * A scoring attempt's outcome.
 *
 * Failure is a value, not an exception: proposals are an enhancement, so a dead
 * provider must leave the deterministic tiers intact and be REPORTED (S12).
 */
export type ConceptEmbedOutcome =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | { readonly ok: false; readonly degradation: ConceptDegradation };

/** Port the resolver needs for scoring; keeps provider concerns out of it. */
export interface ConceptEmbeddingPort {
  /** Identity of the embedding configuration, for logging and cache keys. */
  readonly fingerprint: string;
  /** One vector per input text, in input order. */
  embed(texts: readonly string[]): Promise<ConceptEmbedOutcome>;
}

/** One concept page already in the wiki, reduced to what identity must respect. */
export interface ConceptIncumbentPage {
  /**
   * Frontmatter title the page currently claims. It must slugify to the page's own
   * slug, which is what makes a fold land on the existing page instead of creating a
   * renamed second copy; a hand-edited mismatch degrades to exactly that rename.
   */
  readonly canonicalName: string;
  /** Declared frontmatter aliases, already reduced to plain strings. */
  readonly aliases: readonly string[];
}

/**
 * The existing concept pages, keyed by slug.
 *
 * A snapshot rather than two parallel collections so a caller cannot pair a slug set
 * with the wrong alias map, and so the identity stage has one value to hand around.
 */
export type ConceptIncumbentSnapshot = ReadonlyMap<string, ConceptIncumbentPage>;

/** What resolution needs to know: proposals when available, incumbents always. */
export interface ConceptResolutionOptions {
  readonly embed?: ConceptEmbeddingPort;
  /** Concept pages already in the wiki; their names keep the canonical slot. */
  readonly incumbents?: ConceptIncumbentSnapshot;
}

/** The full result of one resolution run. */
export interface ConceptResolution {
  readonly groups: readonly ConceptGroup[];
  /** Names folded away deterministically; each is now an alias of its page. */
  readonly aliases: readonly ConceptAlias[];
  /** Scored pairs kept as proposals ONLY. Empty when nothing was scored. */
  readonly similarities: readonly ConceptSimilarity[];
  readonly degradation?: ConceptDegradation;
}

/**
 * A cosmetic floor for REPORTING a proposal, never an identity threshold.
 *
 * Pairs below it are still scored and still returned in
 * {@link ConceptResolution.similarities}; they are simply not worth printing, since
 * unrelated concepts routinely clear 0.8 once their summaries are embedded. Nothing
 * in this module reads it to group, rename or merge anything.
 */
export const DEFAULT_PROPOSAL_THRESHOLD = 0.86;

/**
 * Pair budget for the proposal channel.
 *
 * Every pair the name rules left open is a scoring candidate, which is quadratic in
 * the candidate count. Past this budget only pairs sharing a blocking token are
 * compared, which keeps the common case exact and the pathological case bounded
 * without silently doing nothing.
 */
const MAX_SIMILARITY_PAIRS = 20_000;

/** Rank order of the identity tiers; a LOWER rank is stronger evidence. */
const TIER_STRENGTH: Readonly<Record<IdentityTier, number>> = {
  slug: 0,
  normalized: 1,
  alias: 2,
};

/**
 * Total order over names, independent of the host locale.
 *
 * `localeCompare` is deliberately NOT used: its result depends on the ICU data and
 * default locale of the machine, so two compiles of the same sources on different
 * hosts could pick a different canonical name and therefore a different page slug.
 */
function compareNames(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** The strongest of several evidence tiers, or `undefined` when there is none. */
function strongestTier(tiers: readonly IdentityTier[]): IdentityTier | undefined {
  return tiers.reduce<IdentityTier | undefined>(
    (best, tier) => (best === undefined || TIER_STRENGTH[tier] < TIER_STRENGTH[best] ? tier : best),
    undefined,
  );
}

/**
 * Narrows a reported rank to the deterministic tiers.
 *
 * The parameter is deliberately `string` rather than {@link MergeTier}: the rank
 * vocabulary is a type, and a type is not a runtime check. Reaching a rank the name
 * rules do not own means a similarity score found its way back into identity -- the
 * exact regression S6 and S14 forbid -- so this throws instead of silently reporting
 * a deterministic rule that decided nothing.
 *
 * @param tier - A rank reported by the union-find, checked rather than trusted.
 * @returns The same rank, as an {@link IdentityTier}.
 * @throws Error when `tier` is not one of the deterministic name rules.
 */
function identityTierOf(tier: string): IdentityTier {
  if (isDeterministicTier(tier)) {
    return tier;
  }
  throw new Error(
    `"${tier}" is not a deterministic identity rule; similarity cannot decide concept identity`,
  );
}

/** The name-rule tiers: the only ranks the union-find is ever fed. */
type NameRuleTier = "slug" | "normalized";

/** The deterministic tier for one pair, or `undefined` when no rule relates them. */
function deterministicTier(left: string, right: string): NameRuleTier | undefined {
  if (slugify(left) === slugify(right)) {
    return "slug";
  }
  if (canonicalConceptKey(left) === canonicalConceptKey(right)) {
    return "normalized";
  }
  return undefined;
}

/**
 * Applies the name rules to every pair and returns the pairs they left undecided.
 *
 * Those pairs are the ONLY input the scoring channel ever receives, so a pair a rule
 * already folded is never even measured — and a pair it did not fold can only ever
 * become a proposal.
 */
function applyNameRules(
  ordered: readonly ConceptCandidate[],
  forest: ConceptForest,
): Array<readonly [number, number]> {
  const undecided: Array<readonly [number, number]> = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const tier = deterministicTier(ordered[left].name, ordered[right].name);
      if (tier === undefined) {
        undecided.push([left, right]);
        continue;
      }
      unionCandidates(forest, left, right, tier);
    }
  }
  return undecided;
}

/** One existing page a candidate folds into, with the rule that matched it. */
interface IncumbentMatch {
  readonly slug: string;
  readonly tier: IdentityTier;
}

/** The existing wiki, indexed by the two canonical keys alias matching uses. */
interface IncumbentIndex {
  /** Incumbent canonical names and slugs: what the NAME rule and a candidate alias match. */
  readonly byName: ReadonlyMap<string, string>;
  /** Incumbent DECLARED aliases: what a candidate NAME matches at the alias tier. */
  readonly byAlias: ReadonlyMap<string, string>;
}

/** Indexes the incumbent snapshot in a deterministic order. */
function buildIncumbentIndex(
  snapshot: ConceptIncumbentSnapshot | undefined,
): IncumbentIndex {
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const remember = (map: Map<string, string>, key: string, slug: string): void => {
    if (key !== "" && !map.has(key)) {
      map.set(key, slug);
    }
  };
  for (const slug of [...(snapshot?.keys() ?? [])].sort(compareNames)) {
    const page = snapshot?.get(slug);
    if (page === undefined) {
      continue;
    }
    for (const key of [canonicalConceptKey(page.canonicalName), canonicalSlugKey(slug)]) {
      remember(byName, key, slug);
    }
    for (const alias of page.aliases) {
      remember(byAlias, canonicalConceptKey(alias), slug);
    }
  }
  return { byName, byAlias };
}

/**
 * The incumbent page one candidate is equivalent to, if any.
 *
 * Three deterministic comparisons, in the order that keeps reporting honest:
 *
 *   1. the candidate's NAME against the page's canonical name or slug — a name rule,
 *      reported at the tier that rule earns;
 *   2. the candidate's NAME against one of the page's DECLARED aliases — the wiki's own
 *      record that this spelling already meant this page;
 *   3. one of the candidate's own aliases against the page's canonical name or slug.
 *
 * The `alias` tier is reserved for folds only an alias could explain, so a
 * morphological match is never reported as an alias one.
 */
function matchIncumbent(
  candidate: ConceptCandidate,
  index: IncumbentIndex,
): IncumbentMatch | undefined {
  const nameKey = canonicalConceptKey(candidate.name);
  const nameHit = index.byName.get(nameKey);
  if (nameHit !== undefined) {
    return { slug: nameHit, tier: slugify(candidate.name) === nameHit ? "slug" : "normalized" };
  }
  const declaredHit = index.byAlias.get(nameKey);
  if (declaredHit !== undefined) {
    return { slug: declaredHit, tier: "alias" };
  }
  for (const alias of [...(candidate.aliases ?? [])].sort(compareNames)) {
    const hit = index.byName.get(canonicalConceptKey(alias));
    if (hit !== undefined) {
      return { slug: hit, tier: "alias" };
    }
  }
  return undefined;
}

/** One resolved group: every candidate that lands on a single concept page. */
interface GroupView {
  readonly members: readonly number[];
  /** Name-rule tiers of the clusters a rule folded. */
  readonly nameTiers: readonly IdentityTier[];
  readonly incumbent?: IncumbentMatch;
}

/**
 * Groups the name-rule clusters, merging every cluster that resolves to one existing
 * page.
 *
 * Two candidates can each reach the same incumbent through different aliases;
 * without this merge they would become two groups claiming one page, which is the
 * split the alias tier exists to prevent.
 */
function groupViews(
  ordered: readonly ConceptCandidate[],
  forest: ConceptForest,
  matches: ReadonlyMap<number, IncumbentMatch>,
): GroupView[] {
  const byKey = new Map<string, { members: number[]; nameTiers: IdentityTier[]; incumbent?: IncumbentMatch }>();
  for (const [root, indices] of groupsByRoot(forest, ordered.length)) {
    const incumbent = indices.map((index) => matches.get(index)).find((match) => match !== undefined);
    const key = incumbent === undefined
      ? `name:${slugify(ordered[indices[0]].name)}`
      : `incumbent:${incumbent.slug}`;
    const entry = byKey.get(key) ?? { members: [], nameTiers: [] };
    entry.members.push(...indices);
    if (indices.length > 1) {
      entry.nameTiers.push(identityTierOf(tierOfRoot(forest, root)));
    }
    entry.incumbent = entry.incumbent ?? incumbent;
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((entry) => ({
    members: entry.members,
    nameTiers: entry.nameTiers,
    ...(entry.incumbent === undefined ? {} : { incumbent: entry.incumbent }),
  }));
}

/** The claim a group makes about how its members became one concept. */
function groupTier(view: GroupView): IdentityTier {
  const incumbentTier = view.incumbent === undefined ? [] : [view.incumbent.tier];
  return strongestTier([...view.nameTiers, ...incumbentTier]) ?? "slug";
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
  incumbents: ConceptIncumbentSnapshot | undefined,
): ConceptCandidate {
  const incumbent = members.find((member) => incumbents?.has(slugify(member.name)) === true);
  if (incumbent !== undefined) {
    return incumbent;
  }
  return [...members].sort((left, right) => {
    const byConfidence = (right.confidence ?? 0) - (left.confidence ?? 0);
    return byConfidence !== 0 ? byConfidence : compareNames(left.name, right.name);
  })[0];
}

/** The name the group's page will carry: the existing page wins when there is one. */
function canonicalNameOf(
  view: GroupView,
  ordered: readonly ConceptCandidate[],
  snapshot: ConceptIncumbentSnapshot | undefined,
): string {
  if (view.incumbent !== undefined) {
    return snapshot?.get(view.incumbent.slug)?.canonicalName ?? view.incumbent.slug;
  }
  return pickCanonical(view.members.map((index) => ordered[index]), snapshot).name;
}

/** One alias per folded-away candidate, each routed by the fold that absorbed it. */
function aliasesOf(
  view: GroupView,
  canonicalName: string,
  ordered: readonly ConceptCandidate[],
  forest: ConceptForest,
  matches: ReadonlyMap<number, IncumbentMatch>,
): ConceptAlias[] {
  const canonicalSlug = slugify(canonicalName);
  const aliases: ConceptAlias[] = [];
  for (const index of view.members) {
    const name = ordered[index].name;
    if (name === canonicalName) {
      continue;
    }
    const evidence: IdentityTier[] = [];
    if (view.nameTiers.length > 0) {
      evidence.push(identityTierOf(tierThatJoined(forest, index)));
    }
    const match = matches.get(index);
    if (match !== undefined) {
      evidence.push(match.tier);
    }
    aliases.push({ aliasSlug: slugify(name), canonicalSlug, tier: strongestTier(evidence) ?? "slug" });
  }
  return aliases;
}

/** The text actually embedded for one candidate. */
function identityText(candidate: ConceptCandidate): string {
  return [candidate.name, candidate.summary ?? "", (candidate.tags ?? []).join(", ")].join("\n");
}

/** Embeds every needed candidate text once and returns the vector per index. */
async function embedCandidates(
  ordered: readonly ConceptCandidate[],
  needed: ReadonlySet<number>,
  port: ConceptEmbeddingPort,
): Promise<{ vectors: Map<number, readonly number[]>; degradation?: ConceptDegradation }> {
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

/**
 * Whether a pair is worth scoring at all.
 *
 * `tagsConflict` is a HARD exclusion: a disjoint tag set is positive evidence that
 * two concepts differ, so no score can make their comparison informative.
 */
function isComparable(
  left: ConceptCandidate,
  right: ConceptCandidate,
  requireBlockingSignal: boolean,
): boolean {
  if (tagsConflict(left.tags, right.tags)) {
    return false;
  }
  return !requireBlockingSignal || sharesBlockingSignal(left.name, left.tags, right.name, right.tags);
}

/** What the proposal channel produced, and why it produced nothing when it did not. */
interface ProposalOutcome {
  readonly similarities: ConceptSimilarity[];
  readonly degradation?: ConceptDegradation;
}

/** Scores the pairs no rule folded and that landed in different groups. */
async function similarityProposals(
  ordered: readonly ConceptCandidate[],
  undecided: ReadonlyArray<readonly [number, number]>,
  groupOf: readonly number[],
  options: ConceptResolutionOptions,
): Promise<ProposalOutcome> {
  const requireBlockingSignal = undecided.length > MAX_SIMILARITY_PAIRS;
  const pairs = undecided.filter(([left, right]) =>
    groupOf[left] !== groupOf[right] && isComparable(ordered[left], ordered[right], requireBlockingSignal));
  if (pairs.length === 0) {
    return { similarities: [] };
  }
  if (options.embed === undefined) {
    return {
      similarities: [],
      degradation: { reason: "embeddings-unconfigured", detail: "no embedding port supplied" },
    };
  }
  const needed = new Set<number>();
  for (const [left, right] of pairs) {
    needed.add(left);
    needed.add(right);
  }
  const embedded = await embedCandidates(ordered, needed, options.embed);
  const similarities: ConceptSimilarity[] = [];
  for (const [left, right] of pairs) {
    const leftVector = embedded.vectors.get(left);
    const rightVector = embedded.vectors.get(right);
    if (leftVector === undefined || rightVector === undefined) {
      continue;
    }
    similarities.push({
      leftName: ordered[left].name,
      rightName: ordered[right].name,
      score: cosineSimilarity([...leftVector], [...rightVector]),
    });
  }
  return embedded.degradation === undefined
    ? { similarities }
    : { similarities, degradation: embedded.degradation };
}

/**
 * Resolves a batch of concepts into groups of equivalent names.
 *
 * Runs the deterministic tiers, then offers the pairs they left open to the
 * embedding port purely as proposals. Never folds on a score.
 *
 * @param candidates - Every concept extracted in this compile.
 * @param options - Proposal port and the existing concept pages.
 * @returns Groups, deterministic aliases, similarity proposals, and any degradation.
 */
export async function resolveConceptIdentity(
  candidates: readonly ConceptCandidate[],
  options: ConceptResolutionOptions = {},
): Promise<ConceptResolution> {
  const ordered = [...candidates].sort((left, right) => compareNames(left.name, right.name));
  const forest = createConceptForest(ordered.length);
  const undecided = applyNameRules(ordered, forest);
  const index = buildIncumbentIndex(options.incumbents);
  const matches = new Map<number, IncumbentMatch>();
  ordered.forEach((candidate, position) => {
    // A candidate that already HAS its own page is never folded into a different
    // one by an alias match: it is the incumbent, and the name rules decide which
    // of its synonyms joins it. Overriding that would move a live page whenever a
    // key happened to be shared by two pages the alias split left behind.
    if (options.incumbents?.has(slugify(candidate.name)) === true) {
      return;
    }
    const match = matchIncumbent(candidate, index);
    if (match !== undefined) {
      matches.set(position, match);
    }
  });
  const groups: ConceptGroup[] = [];
  const aliases: ConceptAlias[] = [];
  const groupOf: number[] = [];
  groupViews(ordered, forest, matches).forEach((view, ordinal) => {
    const canonicalName = canonicalNameOf(view, ordered, options.incumbents);
    groups.push({
      canonicalName,
      members: view.members.map((position) => ordered[position]),
      tier: groupTier(view),
    });
    aliases.push(...aliasesOf(view, canonicalName, ordered, forest, matches));
    for (const position of view.members) {
      groupOf[position] = ordinal;
    }
  });
  const proposals = await similarityProposals(ordered, undecided, groupOf, options);
  const resolution: ConceptResolution = { groups, aliases, similarities: proposals.similarities };
  return proposals.degradation === undefined
    ? resolution
    : { ...resolution, degradation: proposals.degradation };
}
