/**
 * @file scripts/link-candidates.ts
 * @description The store-independent core of the semantic link-candidate report:
 * which (paragraph → concept) pairs a lexical channel could already have found,
 * how the remaining ones stratify by stored cosine, and which bounded sample a
 * human labels by hand.
 *
 * WHY THIS MODULE EXISTS. Every link channel the compiler has is lexical: the
 * model writes some wikilinks inline, a regex resolver matches canonical page
 * titles, and the backlink review only collects literal mentions. So a relation
 * that is real but never *named* in a paragraph is never considered at all. The
 * stored page- and chunk-level embeddings can rank exactly those relations, but
 * nothing yet says whether the ranking is precise enough to act on. This module
 * is the measuring stick for that question, not a writer: it produces a report a
 * human reads, and it touches no page, no corpus and no compile path.
 *
 * WHY THE CORE IS SEPARATE FROM THE COMMAND. Everything here is pure — no file
 * read, no database, no argv, no clock, no `Math.random` — so the report's two
 * load-bearing claims are provable without a corpus: that a pair the lexical
 * channels already produce is excluded (otherwise the "incremental" set would be
 * padded with links nobody needs), and that the hand-labelled sample is the same
 * sample for the same seed (otherwise two people measuring the same corpus would
 * silently measure different samples and their precision numbers would not be
 * comparable).
 */

import { canonicalConceptKey } from "../packages/wiki/src/dimensions/wiki/concept-identity.js";

/**
 * The separator `canonicalConceptKey` joins its tokens with.
 *
 * `concept-identity.ts` keeps its own `KEY_SEPARATOR` private, so the value is
 * restated here rather than guessed: a canonical key is tokens joined by a single
 * space, and splitting on that same space gives back the project's tokens. Names
 * and texts are compared as CONTIGUOUS TOKEN SEQUENCES, never as substrings of
 * the joined key — that is what makes the match word-bounded, so `role` cannot
 * match inside a longer word and `api` cannot match inside `rapid`.
 */
const KEY_TOKEN_SEPARATOR = " ";

/**
 * Inclusive cosine lower bounds the report stratifies by.
 *
 * `0.86` is not invented here: it is `DEFAULT_PROPOSAL_THRESHOLD` from
 * `packages/wiki/src/dimensions/wiki/concept-resolution.ts:186`, the floor the
 * existing concept-proposal channel already uses to decide a pair is worth
 * printing. Anchoring the top stratum to the number the codebase already trusts
 * makes the measurement a statement about a channel that exists rather than about
 * a threshold chosen to flatter it.
 *
 * `0.80` and `0.75` are the two extra strata the measurement brief names, so the
 * recall gained and the precision lost below the existing floor are visible
 * instead of assumed.
 */
export const CANDIDATE_THRESHOLDS = [0.86, 0.8, 0.75] as const;

/**
 * How many pairs one threshold's hand-labellable sample holds.
 *
 * Small enough that a human actually finishes labelling it, large enough that the
 * resulting precision estimate means something at the strata sizes a real corpus
 * produces.
 */
export const DEFAULT_SAMPLE_SIZE = 20;

/**
 * Default seed for that sample.
 *
 * Fixed rather than clock-derived so the same corpus yields the same sample on
 * every run: a precision number nobody can reproduce is not a measurement.
 */
export const DEFAULT_SAMPLE_SEED = 20250919;

/** Longest excerpt kept for one report row, ellipsis included. */
const EXCERPT_MAX_LENGTH = 200;

/** Marker appended when an excerpt was cut. */
const ELLIPSIS = "…";

/** Decimal places kept for the cosine in a report row. */
const COSINE_DECIMALS = 4;

/** Increment of the mulberry32 state word (public-domain reference algorithm). */
const MULBERRY_INCREMENT = 0x6d2b79f5;

/** First mixing shift of mulberry32. */
const MULBERRY_SHIFT_A = 15;

/** Second mixing shift of mulberry32. */
const MULBERRY_SHIFT_B = 7;

/** Final mixing shift of mulberry32. */
const MULBERRY_SHIFT_C = 14;

/** Odd orbit constant mulberry32 mixes the second step with. */
const MULBERRY_ORBIT = 61;

/** Width of the 32-bit word mulberry32 emits, used to map it into `[0, 1)`. */
const UINT32_RANGE = 4_294_967_296;

/** A candidate (paragraph → concept) pair before lexical exclusion. */
export interface RawCandidatePair {
  corpus: string;
  paragraphId: string;
  documentId: string;
  conceptId: string;
  conceptTitle: string;
  conceptNames: readonly string[];
  cosine: number;
  paragraphText: string;
  documentText: string;
}

/**
 * A raw pair plus the two fields the report derives from it.
 *
 * `documentMention` is kept beside the pair rather than recomputed by the reader
 * because it is evidence, not formatting: a paragraph that does not name a
 * concept it is genuinely about, inside a document that does name it, is the
 * shape this whole channel is looking for.
 */
export interface RenderedCandidatePair extends RawCandidatePair {
  documentMention: boolean;
  excerpt: string;
}

/** One threshold's view of the same candidate set. */
export interface StratumReport {
  threshold: number;
  candidates: RenderedCandidatePair[];
  candidateCount: number;
  excludedByLexicalCount: number;
  incrementalCount: number;
  incremental: RenderedCandidatePair[];
}

/**
 * Split a canonical key back into the tokens it was joined from.
 *
 * @param name - Any concept name or text.
 * @returns The canonical tokens, empty when the input has no word characters.
 */
function canonicalTokens(name: string): string[] {
  return canonicalConceptKey(name)
    .split(KEY_TOKEN_SEPARATOR)
    .filter((token) => token.length > 0);
}

/**
 * Whether `needle` occurs as a contiguous run inside `haystack`.
 *
 * @param haystack - Tokens to search in.
 * @param needle - Tokens to search for.
 * @returns True only for a full, order-preserving, adjacent match.
 */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  const lastStart = haystack.length - needle.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a concept name appears in a text, word-bounded.
 *
 * Word-boundedness is the whole point: the lexical channels match whole titles
 * and aliases, so a substring hit inside a longer word would wrongly mark a pair
 * as already discovered and delete it from the incremental set.
 *
 * @param name - A concept title or declared alias.
 * @param text - The paragraph or document text to search.
 * @returns True when the name's token sequence occurs contiguously in the text.
 */
export function nameAppearsInText(name: string, text: string): boolean {
  const nameTokens = canonicalTokens(name);
  if (nameTokens.length === 0) {
    return false;
  }
  return containsRun(canonicalTokens(text), nameTokens);
}

/**
 * Whether any of the pair's names appears in its paragraph.
 *
 * @param pair - A raw candidate pair.
 * @returns True when a lexical channel would already have produced this link.
 */
export function isLexicallyCovered(pair: RawCandidatePair): boolean {
  return pair.conceptNames.some((name) => nameAppearsInText(name, pair.paragraphText));
}

/**
 * Whether the pair points a paragraph at its own document.
 *
 * A page is always similar to itself, so those pairs would dominate every stratum
 * while carrying no information. They are dropped before stratification, never
 * counted.
 *
 * @param pair - A raw candidate pair.
 * @returns True when the concept IS the owning document.
 */
export function isSelfPair(pair: RawCandidatePair): boolean {
  return pair.conceptId === pair.documentId;
}

/**
 * Collapse a paragraph into one bounded report line.
 *
 * @param text - The raw paragraph text.
 * @returns Single-line text, at most {@link EXCERPT_MAX_LENGTH} characters.
 */
function toExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= EXCERPT_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, EXCERPT_MAX_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * Add the derived report fields to a raw pair.
 *
 * @param pair - A raw candidate pair.
 * @returns The pair with its document-level mention flag and its excerpt.
 */
export function renderCandidatePair(pair: RawCandidatePair): RenderedCandidatePair {
  const documentMention = pair.conceptNames.some((name) => nameAppearsInText(name, pair.documentText));
  return { ...pair, documentMention, excerpt: toExcerpt(pair.paragraphText) };
}

/**
 * Compare two strings by code unit, so ordering never depends on the locale.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero or positive.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The report's total order: cosine descending, then the identity fields ascending.
 *
 * @param left - First pair.
 * @param right - Second pair.
 * @returns Negative, zero or positive.
 */
function compareCandidates(left: RawCandidatePair, right: RawCandidatePair): number {
  if (left.cosine !== right.cosine) {
    return right.cosine - left.cosine;
  }
  return (
    compareStrings(left.corpus, right.corpus) ||
    compareStrings(left.paragraphId, right.paragraphId) ||
    compareStrings(left.conceptId, right.conceptId)
  );
}

/**
 * Copy a candidate list into the report's total order.
 *
 * @param candidates - Candidates in any order.
 * @returns A new, sorted array.
 */
function sortCandidates<T extends RawCandidatePair>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareCandidates);
}

/**
 * Build one threshold's stratum from an already ordered candidate list.
 *
 * @param candidates - Rendered candidates in report order.
 * @param threshold - Inclusive cosine lower bound.
 * @returns That stratum's report.
 */
function buildStratum(candidates: readonly RenderedCandidatePair[], threshold: number): StratumReport {
  const inStratum = candidates.filter((candidate) => candidate.cosine >= threshold);
  const incremental = inStratum.filter((candidate) => !isLexicallyCovered(candidate));
  return {
    threshold,
    candidates: inStratum,
    candidateCount: inStratum.length,
    excludedByLexicalCount: inStratum.length - incremental.length,
    incrementalCount: incremental.length,
    incremental,
  };
}

/**
 * Stratify the candidate set by inclusive cosine lower bound.
 *
 * Strata are NESTED, not disjoint: a pair at 0.90 is reported in all three, so
 * each threshold's numbers answer "if we wired this floor into compile, what
 * would we gain" at that floor rather than "what does this band add".
 *
 * @param pairs - Raw candidate pairs, in any order.
 * @param thresholds - Inclusive lower bounds, highest first.
 * @returns One report per threshold, each in the report's total order.
 */
export function stratifyCandidates(
  pairs: readonly RawCandidatePair[],
  thresholds: readonly number[] = CANDIDATE_THRESHOLDS,
): StratumReport[] {
  const ordered = sortCandidates(pairs.filter((pair) => !isSelfPair(pair)).map(renderCandidatePair));
  return thresholds.map((threshold) => buildStratum(ordered, threshold));
}

/**
 * Create a deterministic `[0, 1)` generator (mulberry32).
 *
 * Integer-only on purpose: `Math.random`, a clock or a locale-dependent sort would
 * make the label sample irreproducible across runs, processes and platforms.
 *
 * @param seed - Any integer; `0` is a real seed, not "unset".
 * @returns A generator returning the next float in `[0, 1)`.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> MULBERRY_SHIFT_A), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> MULBERRY_SHIFT_B), mixed | MULBERRY_ORBIT);
    return ((mixed ^ (mixed >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32_RANGE;
  };
}

/**
 * Draw a bounded, uniformly random, reproducible sample of candidates.
 *
 * The list is put in the report's total order first, so the same seed draws the
 * same pairs no matter what order the caller collected them in. Drawing is
 * Fisher-Yates without replacement over the index range.
 *
 * @param candidates - Candidates to sample from, normally one stratum's survivors.
 * @param size - Requested sample size; a value of zero or less draws nothing.
 * @param seed - PRNG seed; the same seed yields a byte-identical result.
 * @returns `min(size, candidates.length)` pairs, in draw order.
 */
export function sampleCandidates(
  candidates: readonly RenderedCandidatePair[],
  size: number,
  seed: number,
): RenderedCandidatePair[] {
  const pool = sortCandidates(candidates);
  const requested = Math.floor(size);
  if (requested <= 0) {
    return [];
  }
  const take = Math.min(requested, pool.length);
  const random = mulberry32(seed);
  const drawn: RenderedCandidatePair[] = [];
  for (let index = 0; index < take; index += 1) {
    const swapAt = index + Math.floor(random() * (pool.length - index));
    const held = pool[swapAt];
    pool[swapAt] = pool[index];
    pool[index] = held;
    drawn.push(pool[index]);
  }
  return drawn;
}

/**
 * Render one candidate as a single tab-separated report row.
 *
 * The fields are the ones the measurement brief names — corpus, paragraph,
 * concept, cosine, document-level mention, excerpt — and nothing else: the caller
 * assembles the document around this line, so it must stay one line and one shape.
 *
 * @param pair - A rendered candidate.
 * @returns Six tab-separated fields with no embedded newline.
 */
export function formatCandidateRow(pair: RenderedCandidatePair): string {
  return [
    pair.corpus,
    pair.paragraphId,
    pair.conceptId,
    pair.cosine.toFixed(COSINE_DECIMALS),
    pair.documentMention ? "yes" : "no",
    pair.excerpt,
  ].join("\t");
}
