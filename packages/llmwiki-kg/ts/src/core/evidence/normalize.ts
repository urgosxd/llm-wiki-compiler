/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/normalize.ts
 * @description The controlled folds used to look for a quote, and the mapping
 * that turns a match in the folded text back into offsets in the original.
 *
 * ## Why an explicit, closed fold list
 *
 * S11 asks for a quote check "contemplando normalizaciones controladas". The
 * danger is not folding too little, it is folding too much: stemming, synonymy,
 * fuzzy edit distance or semantic similarity would each make a quote "found"
 * without the source containing it, which is exactly the silent degradation the
 * evidence stage exists to prevent. The folds below are spelling-level only:
 *
 * | Fold | What it absorbs | Example |
 * | --- | --- | --- |
 * | case | `toLowerCase` per code unit | `Policy` / `policy` |
 * | whitespace | any `\s` run becomes one space; leading/trailing runs dropped | `a\n  b` / `a b` |
 * | quotes | typographic quote variants become `'` or `"` | `“deja”` / `"deja"` |
 * | dashes | hyphen, en/em dash, minus and figure dash variants become `-` | `—` / `-` |
 * | invisible | soft hyphen, zero-width space/joiners and a BOM are removed | `a\ufeffb` / `ab` |
 *
 * Nothing else is folded. `proces.` does not match `process.`, `roles execute`
 * does not match `A role executes`, and no accent is stripped.
 *
 * ## Why the mapping is per character
 *
 * Offsets must be verifiable in the text the database stores, so the folded copy
 * keeps, for every folded character, the range of the original it came from. A
 * whitespace run collapses to one space that maps to the whole run; a character
 * whose lowercase form is longer than itself maps each half to the same original
 * character. The folded text is therefore a comparison key and never a value to
 * return as content.
 */

/**
 * A folded copy of one text plus its offset mapping.
 *
 * `text` is built one code unit per `sourceStart`/`sourceEnd` entry, so an index
 * into `text` is also an index into the two mapping arrays.
 */
export interface FoldedText {
  /** The folded text, used only for comparison. */
  readonly text: string;
  /** `sourceStart[i]`: original offset of the first character folded into `text[i]`. */
  readonly sourceStart: readonly number[];
  /** `sourceEnd[i]`: original offset one past the last character folded into `text[i]`. */
  readonly sourceEnd: readonly number[];
}

/** Typographic quote characters, folded to their ASCII equivalent. */
const QUOTE_FOLDS: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u2032": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  "\u2033": '"',
};

/** Dash characters, folded to the ASCII hyphen. */
const DASH_FOLDS: Readonly<Record<string, string>> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\uFE58": "-",
  "\uFE63": "-",
  "\uFF0D": "-",
};

/** Invisible characters with no spelling value, removed before comparison. */
const IGNORED: ReadonlySet<string> = new Set(["\u00AD", "\u200B", "\u200C", "\u200D", "\uFEFF"]);

/** One whitespace character, including non-breaking and ideographic spaces. */
const WHITESPACE = /\s/u;

/** One run of whitespace in the original text, as `[start, end)` offsets. */
interface WhitespaceRun {
  readonly start: number;
  readonly end: number;
}

/**
 * Extends the pending whitespace run by one character.
 *
 * A free function rather than an inline spread so the parameter type is the full
 * `WhitespaceRun | null`: control-flow narrowing inside the loop would otherwise
 * reduce the first assignment's left-hand side to `never`.
 *
 * @param run - The run so far, or null when this is its first character.
 * @param index - Index of the whitespace character being absorbed.
 * @returns The extended run.
 */
function extendRun(run: WhitespaceRun | null, index: number): WhitespaceRun {
  return { start: run === null ? index : run.start, end: index + 1 };
}

/**
 * Folds one code unit.
 *
 * A lone surrogate has no case form, so it folds to itself; that keeps the
 * mapping exact for astral characters instead of dropping half a pair.
 *
 * @param ch - One UTF-16 code unit of the original text.
 * @returns Its folded form, possibly more than one code unit long.
 */
function foldChar(ch: string): string {
  return QUOTE_FOLDS[ch] ?? DASH_FOLDS[ch] ?? ch.toLowerCase();
}

/**
 * Builds the comparison key for a text, with offsets back into the original.
 *
 * The fold is a single left-to-right pass, so a whitespace run that is buffered
 * and emitted on the next visible character maps to the run's full original
 * range, and a run at either end disappears (the trim).
 *
 * @param text - Original text, as stored.
 * @returns The folded text and its offset mapping.
 */
export function foldText(text: string): FoldedText {
  const chars: string[] = [];
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  let spaceRun: WhitespaceRun | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (IGNORED.has(ch)) {
      continue;
    }
    if (WHITESPACE.test(ch)) {
      spaceRun = extendRun(spaceRun, index);
      continue;
    }
    if (spaceRun !== null) {
      // A run before the first visible character is leading whitespace: dropped,
      // which is why an already-folded quote never starts with a space.
      if (chars.length > 0) {
        pushFolded(chars, sourceStart, sourceEnd, " ", spaceRun.start, spaceRun.end);
      }
      spaceRun = null;
    }
    pushFolded(chars, sourceStart, sourceEnd, foldChar(ch), index, index + 1);
  }

  return { text: chars.join(""), sourceStart, sourceEnd };
}

/**
 * Appends a folded piece, recording the original range it came from for every
 * code unit of the piece.
 *
 * @param chars - Folded code units accumulated so far.
 * @param sourceStart - Parallel array of start offsets.
 * @param sourceEnd - Parallel array of end offsets.
 * @param folded - The folded piece; often one code unit, sometimes more.
 * @param start - Original offset of the character(s) folded into `folded`.
 * @param end - Original offset one past them.
 */
function pushFolded(
  chars: string[],
  sourceStart: number[],
  sourceEnd: number[],
  folded: string,
  start: number,
  end: number,
): void {
  for (let offset = 0; offset < folded.length; offset += 1) {
    chars.push(folded.charAt(offset));
    sourceStart.push(start);
    sourceEnd.push(end);
  }
}
