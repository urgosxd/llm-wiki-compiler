/**
 * @file src/dimensions/wiki/concept-identity.ts
 * @description Tier 0 and tier 1 of wiki concept identity: exact and
 * deterministic canonicalization.
 *
 * The compiler identifies a concept by its slug
 * (`src/utils/markdown.ts:69`), which is purely lexical. Reconciliation in
 * `src/compiler/extraction-merge.ts` therefore only fires when two concept names
 * slugify to the same bytes, so a synonym such as "Vector DB" against "Vector
 * Database" becomes two pages that describe one thing.
 *
 * This module supplies the identity that the slug cannot: a canonical key built
 * by folding case, expanding a small, reviewed set of acronyms, and stemming
 * plurals. It is deliberately deterministic and dependency-free — no LLM call, no
 * embedding request — because the cheapest correct answer beats a semantic one
 * whenever an explicit rule is available. Everything it cannot decide is left to
 * the cosine tiers in `concept-resolution.ts`.
 *
 * What it does NOT do: it never invents a name. The canonical key is an identity
 * key only. The display name of a merged group is decided by the resolver, which
 * keeps the incumbent name so that page slugs, inbound links and provenance
 * survive a merge unchanged.
 */

/** Separator placed between the tokens of a canonical key. */
const KEY_SEPARATOR = " ";

/**
 * Reviewed acronym expansions. Each entry collapses one well-known abbreviation
 * onto the phrase it abbreviates, so "DB" and "Database" share a key.
 *
 * Kept intentionally small: every entry is a claim that the two spellings are
 * ALWAYS the same concept, and a wrong entry is a silent false merge. Only add a
 * pair when that claim is true in every domain the wiki compiles.
 */
const ACRONYM_EXPANSIONS: Readonly<Record<string, string>> = {
  api: "application programming interface",
  db: "database",
  llm: "large language model",
  ml: "machine learning",
  nlp: "natural language processing",
  rag: "retrieval augmented generation",
  sdk: "software development kit",
  ui: "user interface",
};

/**
 * Heads of the sibilant singulars whose plural adds a whole "-es".
 *
 * Tested as two conditions — the token ends "es" AND its head ends in one of these
 * — so the stemmer removes exactly the two characters the plural added. Testing the
 * full plural ending instead would eat part of the word: matching "ches" against
 * "matches" leaves "mat".
 *
 * The doubled-"s" head is "ss", which only matches a token ending "sses", never the
 * "ses" of a silent-e stem such as "databases".
 */
const SIBILANT_HEADS: readonly string[] = ["ss", "x", "z", "ch", "sh"];

/** The "-ies" plural, which also restores the "y" it replaced. */
const IES_SUFFIX = "ies";

/** Length of the "-es" plural marker. */
const ES_LENGTH = 2;

/** Length of the "-s" plural marker. */
const S_LENGTH = 1;

/** Doubled "s" at the end of a singular that must not be read as a plural. */
const DOUBLE_S = "ss";

/** The "-es" plural a silent-e singular takes, e.g. "buses" for "bus"+"e". */
const SILENT_E_ES = "es";


/** Shortest token left after plural stemming; guards "is" → "i". */
const MIN_STEMMED_LENGTH = 3;

/** Minimum token length that participates in blocking; short tokens over-match. */
const MIN_BLOCKING_TOKEN_LENGTH = 3;

/**
 * Split a concept name into lowercase word tokens.
 *
 * Punctuation is treated as a separator rather than deleted, so "RAG-based" and
 * "RAG based" agree. Unlike `slugify`, a hyphen is not preserved: the key is a
 * token sequence, not a filesystem-safe identifier.
 *
 * @param name - A concept name as returned by the extraction LLM.
 * @returns Its lowercase tokens, possibly empty.
 */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/['’]/gu, "")
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length > 0);
}

/**
 * Returns `stem` when it is still a word, otherwise the untouched token.
 *
 * Guarding here rather than at each call site is what stops a short word from
 * collapsing into a fragment when a suffix happens to match it.
 */
function orUnchanged(stem: string, token: string): string {
  return stem.length < MIN_STEMMED_LENGTH ? token : stem;
}

/**
 * Stem one lowercase token to its singular form.
 *
 * Three rules, applied in order, each removing EXACTLY the characters the plural
 * added: "-ies" becomes "y"; a sibilant head plus "es" drops just the "-es";
 * anything else ending in "s" drops that single "s". Getting the removed length
 * right is the whole point — stripping a matched ending rather than the added
 * characters turned "classes" into "cla" and "matches" into "mat".
 *
 * @param token - A lowercase, punctuation-free token.
 * @returns The singular form, or the token unchanged when no rule applies.
 */
function stemPlural(token: string): string {
  if (token.length <= MIN_STEMMED_LENGTH) {
    return token;
  }
  if (token.endsWith(IES_SUFFIX)) {
    const stem = token.slice(0, token.length - IES_SUFFIX.length);
    return stem.length < MIN_STEMMED_LENGTH ? token : `${stem}y`;
  }
  const sibilantStem = sibilantEsStem(token);
  if (sibilantStem !== undefined) {
    return sibilantStem;
  }
  if (token.endsWith("s")) {
    return stemNonSibilantS(token);
  }
  return token;
}

/**
 * The stem of an "-es" plural whose singular ends in a sibilant.
 *
 * Requires the token to END in "es", so a bare "-s" plural never matches here.
 *
 * @returns The stem with the "-es" removed, or `undefined` when this is not a
 *   sibilant "-es" plural.
 */
function sibilantEsStem(token: string): string | undefined {
  if (!token.endsWith("es")) {
    return undefined;
  }
  const withoutEs = token.slice(0, token.length - ES_LENGTH);
  if (!SIBILANT_HEADS.some((head) => withoutEs.endsWith(head))) {
    return undefined;
  }
  return orUnchanged(withoutEs, token);
}

/**
 * Resolves the trailing "-s" of a token that is not a sibilant "-es" plural.
 *
 * Dropping exactly one "s" is what makes a silent-e singular fold correctly:
 * "databases" → "database", "notes" → "note", "vectors" → "vector". A doubled-"s"
 * singular is left untouched so "class" is never read as a plural.
 *
 * KNOWN LIMITATION: a singular that itself ends in "s" ("bus" → "buses") yields
 * "buse" rather than "bus". The two cases are not distinguishable — "databases" and
 * "buses" both end in "ses", one adding "-s" to a silent-e stem and the other
 * adding "-es" to an s-ending stem — and resolving them the other way would turn
 * "databases" into "databas". Choosing the silent-e reading means this pair stays a
 * false SPLIT, which is visible and recoverable; the alternative risks a false MERGE,
 * which is silent and permanent.
 */
function stemNonSibilantS(token: string): string {
  if (token.endsWith(DOUBLE_S)) {
    return token;
  }
  return orUnchanged(token.slice(0, token.length - S_LENGTH), token);
}

/**
 * Canonical identity key for one concept name.
 *
 * Folds case, expands reviewed acronyms, stems plurals and joins the tokens with
 * a single space. Two names that produce the same key are the same concept for
 * every downstream tier.
 *
 * @param name - A concept name as returned by the extraction LLM.
 * @returns The canonical key, or `""` when the name carries no word characters.
 */
export function canonicalConceptKey(name: string): string {
  const canonicalTokens: string[] = [];
  for (const token of nameTokens(name)) {
    const expanded = ACRONYM_EXPANSIONS[token];
    if (expanded !== undefined) {
      canonicalTokens.push(...expanded.split(" "));
      continue;
    }
    canonicalTokens.push(stemPlural(token));
  }
  return canonicalTokens.join(KEY_SEPARATOR);
}

/**
 * Identity key for a concept slug.
 *
 * Reuses {@link canonicalConceptKey} so that an existing slug and a fresh concept
 * name are compared by the same rule — the incumbency tier must not use a
 * different notion of sameness than the merge tiers, or a concept could merge
 * under one rule and split under another.
 *
 * @param slug - A slug as stored in `WikiState` or produced by `slugify`.
 * @returns The canonical key for that slug.
 */
export function canonicalSlugKey(slug: string): string {
  return canonicalConceptKey(slug.replace(/-/gu, " "));
}

/**
 * Blocking tokens for a concept: the distinct canonical tokens long enough to
 * discriminate.
 *
 * Two concepts are only worth comparing on embeddings when they share at least
 * one blocking token or at least one tag — see {@link sharesBlockingSignal}.
 *
 * @param name - A concept name.
 * @returns Its distinct blocking tokens, sorted for deterministic iteration.
 */
export function blockingTokens(name: string): string[] {
  const tokens = new Set<string>();
  for (const token of canonicalConceptKey(name).split(KEY_SEPARATOR)) {
    if (token.length >= MIN_BLOCKING_TOKEN_LENGTH) {
      tokens.add(token);
    }
  }
  return [...tokens].sort();
}

/**
 * Whether two concepts are close enough to justify an embedding comparison.
 *
 * This is the quadratic guard: without it every concept is compared against every
 * other one. Sharing a tag counts even when the names share no token, because a
 * shared tag is itself evidence that the two belong to one neighborhood.
 *
 * @param leftName - First concept name.
 * @param leftTags - First concept's tags, if any.
 * @param rightName - Second concept name.
 * @param rightTags - Second concept's tags, if any.
 * @returns True when the pair deserves a cosine comparison.
 */
export function sharesBlockingSignal(
  leftName: string,
  leftTags: readonly string[] | undefined,
  rightName: string,
  rightTags: readonly string[] | undefined,
): boolean {
  const leftTokens = new Set(blockingTokens(leftName));
  for (const token of blockingTokens(rightName)) {
    if (leftTokens.has(token)) {
      return true;
    }
  }
  return tagsOverlap(leftTags, rightTags);
}

/**
 * Whether two concepts carry tags and share none of them.
 *
 * A disjoint tag set is positive evidence that the two concepts are DIFFERENT, so
 * the resolver short-circuits before paying for an embedding request. Concepts
 * with no tags make no claim either way and are never excluded here.
 *
 * @returns True only when both sides have tags and the intersection is empty.
 */
export function tagsConflict(
  leftTags: readonly string[] | undefined,
  rightTags: readonly string[] | undefined,
): boolean {
  if (leftTags === undefined || rightTags === undefined) {
    return false;
  }
  if (leftTags.length === 0 || rightTags.length === 0) {
    return false;
  }
  return !tagsOverlap(leftTags, rightTags);
}

/** Whether two tag lists share at least one tag, case-insensitively. */
function tagsOverlap(
  leftTags: readonly string[] | undefined,
  rightTags: readonly string[] | undefined,
): boolean {
  if (leftTags === undefined || rightTags === undefined || leftTags.length === 0) {
    return false;
  }
  const left = new Set(leftTags.map((tag) => tag.trim().toLowerCase()));
  return rightTags.some((tag) => left.has(tag.trim().toLowerCase()));
}
