/**
 * @file packages/llmwiki-kg/ts/src/core/chunking.ts
 * @description Text chunking: a port of LlamaIndex's `SentenceSplitter`.
 *
 * The splitter runs two phases. The **split phase** walks a separator hierarchy
 * (paragraph, line, sentence, word), breaking a piece only when it exceeds the
 * chunk size. The **merge phase** then recombines adjacent splits up to the chunk
 * size with a token overlap, which is what makes consecutive chunks share
 * context instead of cutting mid-thought.
 *
 * Ported rather than reinvented because chunk boundaries are observable: they
 * decide `chunk_index`, `content_hash`, and therefore what the extractor sees.
 */

import { countTokens } from "./tokenizer.js";
import { splitBySentenceTokenizer } from "./sentence-splitter.js";

// ===========================================================================
// STEP 3: CHUNKING (SentenceSplitter port)
// ===========================================================================

/** `_DEFAULT_CHUNK_SIZE` — token budget per chunk. */
export const DEFAULT_CHUNK_SIZE = 1024;

/** `_DEFAULT_CHUNK_OVERLAP` — token overlap between adjacent chunks. */
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * `CHUNKING_REGEX` — the splitter's backup sentence regex, used only when the
 * paragraph and Punkt splits both fail to divide a long run of text.
 *
 * Note the CJK characters: they are part of the constant in llama_index, and
 * dropping them changes how CJK text — which has no spaces — gets split.
 */
const CHUNKING_REGEX = /[^,.;。？！]+[,.;。？！]?|[,.;。？！]/gu;

/** One split produced by {@link splitPhase}. */
interface Split {
  readonly text: string;
  readonly isSentence: boolean;
  readonly tokenSize: number;
}

/**
 * `split_text_keep_separator` — splits on `separator` and keeps it at the end of
 * each piece, dropping empty pieces.
 *
 * Keeping the separator is what makes the merged chunks reconstruct the original
 * text: the paragraph break and the single space between words both survive.
 */
function splitTextKeepSeparator(text: string, separator: string): string[] {
  const parts = text.split(separator);
  const withSeparator = parts.map((part, index) => (index > 0 ? separator + part : part));
  return withSeparator.filter((part) => part !== "");
}

/**
 * `SentenceSplitter._get_splits_by_fns`.
 *
 * Tries the paragraph separator, then the sentence tokenizer; the first that
 * yields more than one piece wins and marks the pieces as whole sentences. If
 * neither splits, the sub-sentence functions are tried and the pieces are
 * marked as fragments.
 */
function splitsByFns(text: string): { splits: string[]; isSentence: boolean } {
  const paragraphSplits = splitTextKeepSeparator(text, "\n\n");
  if (paragraphSplits.length > 1) {
    return { splits: paragraphSplits, isSentence: true };
  }

  const sentenceSplits = splitBySentenceTokenizer(text);
  if (sentenceSplits.length > 1) {
    return { splits: sentenceSplits, isSentence: true };
  }

  for (const sub of [
    (value: string): string[] => value.match(CHUNKING_REGEX) ?? [],
    (value: string): string[] => splitTextKeepSeparator(value, " "),
    (value: string): string[] => [...value],
  ]) {
    const subSplits = sub(text);
    if (subSplits.length > 1) {
      return { splits: subSplits, isSentence: false };
    }
  }

  // Nothing split: llama_index returns the last attempt's result either way.
  return { splits: paragraphSplits, isSentence: false };
}

/**
 * Counts tokens for one piece of text during chunking.
 *
 * Injectable so the splitting and merging *algorithm* can be verified against
 * the real llama_index splitter with an exact counter, independently of the
 * calibrated {@link countTokens} approximation. Production always uses
 * {@link countTokens}.
 */
export type TokenCounter = (text: string) => number;

/**
 * `SentenceSplitter._split` — recursively break `text` into units no larger than
 * `chunkSize` tokens.
 *
 * The `length === 1` branch is llama_index's guard against infinite recursion on
 * a single indivisible unit larger than the budget; the unit is kept oversized
 * and `_merge` raises instead.
 */
function splitPhase(text: string, chunkSize: number, counter: TokenCounter): Split[] {
  const tokenSize = counter(text);
  if (tokenSize <= chunkSize) {
    return [{ text, isSentence: true, tokenSize }];
  }

  const { splits, isSentence } = splitsByFns(text);
  const out: Split[] = [];
  for (const piece of splits) {
    const size = counter(piece);
    if (size <= chunkSize || splits.length === 1) {
      out.push({ text: piece, isSentence, tokenSize: size });
    } else {
      out.push(...splitPhase(piece, chunkSize, counter));
    }
  }
  return out;
}

/**
 * `SentenceSplitter._merge` — greedily pack splits into chunks, carrying the
 * tail of each chunk forward as overlap for the next one.
 *
 * Two details are load-bearing and easy to lose in a rewrite:
 *
 * - Overlap is added by *closing* a chunk, in reverse order, and only while the
 *   running overlap stays within the budget. The overlap therefore comes from
 *   the end of the previous chunk, not the start of the next split.
 * - When a fresh chunk already carries overlap that would overflow, the overlap
 *   is dropped from the front rather than the split being deferred. Without
 *   this, a chunk could begin with overlap and immediately close, producing an
 *   all-overlap chunk.
 *
 * @throws {Error} when a single split exceeds `chunkSize` tokens — llama_index's
 *   `ValueError("Single token exceeded chunk size")`. Unreachable in practice
 *   because {@link splitPhase} breaks text down to characters first, but kept
 *   because a silent oversized chunk would corrupt the token accounting.
 */
function mergePhase(splits: readonly Split[], chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let current: Array<readonly [string, number]> = [];
  let currentLength = 0;
  let newChunk = true;

  const closeChunk = (): void => {
    chunks.push(current.map(([text]) => text).join(""));
    const last = current;
    current = [];
    currentLength = 0;
    newChunk = true;

    let index = last.length - 1;
    while (index >= 0) {
      const entry = last[index];
      if (entry === undefined || currentLength + entry[1] > chunkOverlap) {
        break;
      }
      currentLength += entry[1];
      current.unshift(entry);
      index -= 1;
    }
  };

  let splitIndex = 0;
  while (splitIndex < splits.length) {
    const split = splits[splitIndex];
    if (split === undefined) {
      break;
    }
    if (split.tokenSize > chunkSize) {
      throw new Error("Single token exceeded chunk size");
    }

    if (currentLength + split.tokenSize > chunkSize && !newChunk) {
      closeChunk();
      continue;
    }

    if (newChunk && currentLength + split.tokenSize > chunkSize) {
      while (current.length > 0 && currentLength + split.tokenSize > chunkSize) {
        const removed = current.shift();
        if (removed !== undefined) {
          currentLength -= removed[1];
        }
      }
    }

    if (split.isSentence || currentLength + split.tokenSize <= chunkSize || newChunk) {
      currentLength += split.tokenSize;
      current.push([split.text, split.tokenSize]);
      splitIndex += 1;
      newChunk = false;
    } else {
      closeChunk();
    }
  }

  if (!newChunk) {
    chunks.push(current.map(([text]) => text).join(""));
  }

  // `_postprocess_chunks`: drop whitespace-only chunks, trim the rest.
  const processed: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed !== "") {
      processed.push(trimmed);
    }
  }
  return processed;
}

/**
 * `SentenceSplitter.split_text`.
 *
 * Exported because it is the one part of this module that can be tested exactly:
 * it is pure, and its output is what the oracle stores into `document_chunks`.
 *
 * @param counter token counter. Defaults to the calibrated {@link countTokens};
 *   tests inject an exact counter to isolate the algorithm from the
 *   approximation.
 */
export function splitText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
  counter: TokenCounter = countTokens,
): string[] {
  // `_split_text("")` returns `[""]`; the caller filters it out via the
  // `text.strip()` check in `chunk_and_embed`.
  if (text === "") {
    return [text];
  }
  return mergePhase(splitPhase(text, chunkSize, counter), chunkSize, chunkOverlap);
}
