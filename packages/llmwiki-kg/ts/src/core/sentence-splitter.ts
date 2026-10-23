/**
 * @file packages/llmwiki-kg/ts/src/core/sentence-splitter.ts
 * @description Sentence segmentation: a port of NLTK's untrained Punkt tokenizer.
 *
 * "Untrained" is the load-bearing word. Punkt normally learns abbreviations and
 * sentence starts from a corpus; LlamaIndex never trains it, so it falls back to
 * fixed heuristics. Those heuristics are what decide where a chunk boundary can
 * fall, which means reproducing them exactly — not approximating them — is what
 * keeps `document_chunks` rows identical to the oracle's.
 */


// ===========================================================================
// STEP 2: SENTENCE SEGMENTATION (untrained Punkt)
// ===========================================================================

/**
 * NLTK's Punkt word-tokenization regex, from
 * `PunktLanguageVars._word_tokenize_fmt`.
 *
 * Verbatim, with one adjustment: Python's `(?=[^\(\"\`{\[:;&\#\*@\)}\]\-,])`
 * lookahead becomes a negated character class with the same members. `\p{L}` and
 * `\p{N}` are not needed here because the class is written as *exclusions*, and
 * the `u` flag makes `\u2018`-style escapes behave as code points.
 */
const PUNKT_WORD =
  /(?:--+|\.{2,}|(?:\.\s){2,}\.)|(?=[^("`\{\[:;&#*@\)\}\],\x2d])\S+?(?=\s|$|[\])"\\;\}\*:@'(\{\[\u2018\u2019\u201c\u201d\u00ab\u00bb?!]|(?:--+|\.{2,}|(?:\.\s){2,}\.)|,(?=$|\s|[\])"\\;\}\*:@'(\{\[\u2018\u2019\u201c\u201d\u00ab\u00bb?!]|(?:--+|\.{2,}|(?:\.\s){2,}\.)))|\S/gu;

/**
 * Punkt's sentence-end-context regex, from
 * `PunktLanguageVars._period_context_fmt`: a candidate end character followed by
 * either other punctuation or whitespace and the next token.
 *
 * `after_tok` and `next_tok` are the two captures the slicing step needs.
 */
const PERIOD_CONTEXT =
  /[.?!](?=(?<after>[)"\];}*:@'([{\u2018\u2019\u201c\u201d\u00ab\u00bb?!]|\s+(?<next>\S+)))/gu;

/** Characters NLTK treats as whitespace when locating the previous word. */
const NLTK_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\u000b", "\u000c"]);

/** `PunktToken._RE_INITIAL` — a single letter followed by a period. */
const PUNKT_INITIAL = /^[^\W\d]\.$/u;

/**
 * Splits `line` into Punkt word tokens.
 *
 * `PunktBaseClass._tokenize_words` runs this per line and skips blank lines;
 * both halves matter, because a blank line is what marks a paragraph start and
 * the tokenizer starts a fresh word at each line.
 */
function punktWords(line: string): string[] {
  return line.match(PUNKT_WORD) ?? [];
}

/**
 * True when the token at `index` is a sentence break, given the token after it.
 *
 * This is Punkt's first pass plus the two second-pass rules that survive with
 * **untrained** parameters (`abbrev_types`, `collocations` and `sent_starters`
 * are all empty, and `ortho_context` is empty, so the orthographic heuristic
 * always answers `"unknown"`):
 *
 * 1. `?` and `!` are always sentence breaks.
 * 2. `.` is a break unless the token is an initial (`A.`, where the heuristic
 *    answers "unknown" and the next word is capitalized without lowercase
 *    evidence — always true when untrained) or ends in `..` (an ellipsis).
 *
 * Because no abbreviation list is loaded, `Mr.` **does** break a sentence. That
 * looks wrong but is what the oracle does — verified against NLTK, which
 * tokenizes `"Mr. Smith went to Washington."` into `["Mr.", "Smith went to
 * Washington."]` with default parameters.
 */
function isSentenceBreak(tokens: readonly string[], index: number): boolean {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (token === undefined || next === undefined) {
    // Punkt ignores the last token of the annotated run.
    return false;
  }
  if (token === "." || token === "?" || token === "!") {
    return true;
  }
  // `_first_pass_annotation`: only tokens ending in a period, and not in `..`.
  if (!token.endsWith(".") || token.endsWith("..")) {
    return false;
  }
  // Second pass: an initial is reclassified as an abbreviation, not a break.
  if (PUNKT_INITIAL.test(token)) {
    return false;
  }
  return true;
}

/**
 * `PunktSentenceTokenizer.text_contains_sentbreak` for a candidate context.
 *
 * The loop returns as soon as a break has been *followed* by another token,
 * which is why a sentence-final break in the last position does not count.
 */
function containsSentenceBreak(context: string): boolean {
  const tokens = context.split("\n").flatMap((line) => punktWords(line));
  for (let index = 0; index < tokens.length; index += 1) {
    if (isSentenceBreak(tokens, index)) {
      return index + 1 < tokens.length;
    }
  }
  return false;
}

/** One candidate boundary: where the match ended and what follows it. */
interface EndCandidate {
  readonly matchStart: number;
  readonly matchEnd: number;
  /** Offset of the token after the break, when there is whitespace between. */
  readonly nextTokenStart: number | undefined;
  /** The context text Punkt inspects to decide whether a break is real. */
  readonly context: string;
}

/** A candidate end-context that is still waiting for the next one to start. */
interface PendingCandidate {
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly after: string;
  readonly nextStart: number | undefined;
  readonly wordStart: number;
  readonly wordEnd: number;
}

/** The half-open range of the word that precedes `matchStart`. */
function previousWord(
  text: string,
  previousSliceStart: number,
  previousSliceEnd: number,
  matchStart: number,
): { readonly wordStart: number; readonly wordEnd: number } {
  // Scan back for the last NLTK whitespace.
  const before = text.slice(previousSliceEnd, matchStart);
  let lastSpace = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    if (NLTK_WHITESPACE.has(before[index] ?? "")) {
      lastSpace = index;
      break;
    }
  }
  const wordStart = lastSpace === 0 ? previousSliceStart : lastSpace + previousSliceEnd + 1;
  return { wordStart, wordEnd: matchStart };
}

/**
 * Builds the pending candidate for one regex match.
 *
 * `match[0]` is only the sentence-end character: everything after it is inside
 * the lookahead. Python reads `match.group("after_tok")` and the context string
 * is `previous word + match.group() + after_tok`, so the looked-ahead text has to
 * be carried here explicitly.
 */
function toPending(
  match: RegExpMatchArray,
  matchStart: number,
  matchEnd: number,
  wordStart: number,
  wordEnd: number,
): PendingCandidate {
  const afterTok = match.groups?.["after"] ?? "";
  const nextGroup = match.groups?.["next"];
  const afterStart = matchStart + match[0].length;
  // `next_tok` is the tail of `after_tok` (whitespace then the token), so its
  // start is the end of `after_tok` minus the token's own length.
  const nextStart =
    nextGroup === undefined ? undefined : afterStart + afterTok.length - nextGroup.length;

  return { matchStart, matchEnd, after: match[0] + afterTok, nextStart, wordStart, wordEnd };
}

/** Finalizes a pending candidate into the shape Punkt inspects. */
function toCandidate(pending: PendingCandidate, text: string): EndCandidate {
  return {
    matchStart: pending.matchStart,
    matchEnd: pending.matchEnd,
    nextTokenStart: pending.nextStart,
    context: text.slice(pending.wordStart, pending.wordEnd) + pending.after,
  };
}

/**
 * The closing punctuation `_realign_boundaries` pulls back onto a sentence.
 *
 * Copied verbatim from the original inline literal, including the `u` flag and
 * the `m` flag: the `m` flag is what makes `$` match at a line end inside the
 * sliced text.
 */
const CLOSING_PUNCTUATION = /^["')\]}\u2018\u2019\u201c\u201d\u00ab\u00bb]+?(?:\s+|(?=--)|$)/mu;

/**
 * `PunktSentenceTokenizer._match_potential_end_contexts`.
 *
 * Walks candidate end characters, and for each one captures the preceding word
 * plus the characters after the break, de-duplicating overlapping matches from
 * runs like `!!!` so only the last one in the run is considered.
 */
function matchPotentialEndContexts(text: string): EndCandidate[] {
  const out: EndCandidate[] = [];
  let previousSliceStart = 0;
  let previousSliceEnd = 0;
  let previous: PendingCandidate | undefined;

  for (const match of text.matchAll(PERIOD_CONTEXT)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    const { wordStart, wordEnd } = previousWord(
      text,
      previousSliceStart,
      previousSliceEnd,
      matchStart,
    );

    if (previous !== undefined && previousSliceEnd <= wordStart) {
      out.push(toCandidate(previous, text));
    }

    previous = toPending(match, matchStart, matchEnd, wordStart, wordEnd);
    previousSliceStart = wordStart;
    previousSliceEnd = wordEnd;
  }

  if (previous !== undefined) {
    out.push(toCandidate(previous, text));
  }
  return out;
}

/** A half-open `[start, end)` range in the original text. */
type Span = readonly [number, number];

/**
 * `_realign_boundaries` — pulls trailing closing punctuation back onto the
 * sentence it closes, and drops empty slices.
 */
function realignBoundaries(raw: readonly Span[], text: string): Span[] {
  const aligned: Span[] = [];
  let realign = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    if (current === undefined) {
      continue;
    }
    const start = current[0] + realign;
    const next = raw[index + 1];

    if (next === undefined) {
      if (text.slice(start, current[1]) !== "") {
        aligned.push([start, current[1]]);
      }
      continue;
    }

    const boundary = CLOSING_PUNCTUATION.exec(text.slice(next[0], next[1]));
    if (boundary !== null) {
      aligned.push([start, next[0] + boundary[0].trimEnd().length]);
      realign = boundary[0].length;
    } else {
      realign = 0;
      if (text.slice(start, current[1]) !== "") {
        aligned.push([start, current[1]]);
      }
    }
  }
  return aligned;
}

/**
 * `PunktSentenceTokenizer._slices_from_text` followed by
 * `_realign_boundaries` — i.e. exactly what `span_tokenize` produces.
 *
 * Slicing keeps everything up to the end of the matched end character, and the
 * next slice starts at the first character of the following token, so the
 * whitespace after a sentence belongs to that sentence. Realignment then pulls
 * trailing closing punctuation (`)` `"` …) back onto the sentence it closes.
 */
function sentenceSpans(text: string): Span[] {
  const raw: Span[] = [];
  let lastBreak = 0;
  for (const candidate of matchPotentialEndContexts(text)) {
    if (containsSentenceBreak(candidate.context)) {
      raw.push([lastBreak, candidate.matchEnd]);
      lastBreak = candidate.nextTokenStart ?? candidate.matchEnd;
    }
  }
  // The trailing slice never includes trailing whitespace.
  raw.push([lastBreak, text.trimEnd().length]);

  return realignBoundaries(raw, text);
}
/**
 * `split_by_sentence_tokenizer_internal`: each sentence runs from its own start
 * to the **start of the next one**, so trailing whitespace stays attached.
 *
 * Using `tokenize` semantics (trimmed sentences) instead would silently change
 * every chunk boundary that falls inside a paragraph.
 */
export function splitBySentenceTokenizer(text: string): string[] {
  const spans = sentenceSpans(text);
  const out: string[] = [];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (span === undefined) {
      continue;
    }
    const next = spans[index + 1];
    out.push(text.slice(span[0], next === undefined ? text.length : next[0]));
  }
  return out;
}
