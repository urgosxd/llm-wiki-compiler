/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/locate.ts
 * @description Locating a candidate's quote in the chunk text it was extracted
 * from, and reporting verifiable offsets in that ORIGINAL text.
 *
 * ## The only two answers
 *
 * A located quote (with a span into the stored chunk content) or `not_found`.
 * There is deliberately no third answer such as a similarity score, a "best
 * effort" span, or a boost for the closest sentence: a quote that is missing must
 * stay missing, because absence is the fact a caller records to keep a weak
 * candidate visible instead of publishing it as verified.
 *
 * ## Chunks are searched one at a time
 *
 * {@link locateQuoteInChunks} asks every chunk the same question and returns the
 * first that contains the whole quote. Offsets are always offsets into THAT
 * chunk's `content` — the column `kg_evidence.char_start` points at — never into
 * a concatenation of chunks. A quote that only exists by joining the end of one
 * chunk to the start of the next is `not_found`; the merge phase of the splitter
 * already gives adjacent chunks an overlap, so genuine cross-boundary text is
 * normally contained in one of them.
 */

import { foldText } from "./normalize.js";
import {
  NOT_FOUND_LOCATION,
  isLocatedQuote,
  type AbsentQuote,
  type LocatedQuote,
  type QuoteLocation,
  type QuoteSpan,
} from "./types.js";

/** The stored shape of one chunk, as `document_chunks` holds it. */
export interface SourceChunk {
  /** Chunk row id when the chunk is already persisted; null before it is. */
  readonly chunkId: string | null;
  /** Position of the chunk inside its document, as stored in `document_chunks`. */
  readonly chunkIndex: number;
  /** The chunk content the offsets refer to. */
  readonly content: string;
}

/** The chunk whose content contains the whole quote, and the span inside it. */
export interface ChunkQuoteMatch {
  readonly status: "found";
  readonly chunk: SourceChunk;
  readonly span: QuoteSpan;
}

/** Result of searching every chunk of a document. */
export type ChunkQuoteLocation = ChunkQuoteMatch | AbsentQuote;

/**
 * Builds a found location.
 *
 * @param charStart - Offset of the first matched character.
 * @param charEnd - Offset one past the last matched character.
 * @param match - Whether the match needed the controlled folds.
 * @returns A located quote carrying a verifiable span.
 */
function found(charStart: number, charEnd: number, match: QuoteSpan["match"]): LocatedQuote {
  return { status: "found", span: { charStart, charEnd, match } };
}

/**
 * Locates `quote` inside one chunk's content.
 *
 * The exact pass runs first so a verbatim quote never depends on the folds. The
 * normalized pass folds both sides with {@link foldText} and maps the hit back to
 * original offsets, so the returned span can be sliced out of the stored text and
 * compared character for character.
 *
 * @param quote - The evidence text as the extractor produced it.
 * @param chunkContent - The chunk content exactly as stored.
 * @returns The span in the original text, or `not_found`.
 */
export function locateQuote(quote: string, chunkContent: string): QuoteLocation {
  const foldedQuote = foldText(quote);
  // A quote with no visible characters is the absence of evidence, not a match,
  // and `indexOf("")` would happily report an empty span.
  if (foldedQuote.text === "") {
    return NOT_FOUND_LOCATION;
  }

  const exactStart = chunkContent.indexOf(quote);
  if (exactStart >= 0) {
    return found(exactStart, exactStart + quote.length, "exact");
  }

  const foldedChunk = foldText(chunkContent);
  const start = foldedChunk.text.indexOf(foldedQuote.text);
  if (start < 0) {
    return NOT_FOUND_LOCATION;
  }

  const lastFoldedIndex = start + foldedQuote.text.length - 1;
  const charStart = foldedChunk.sourceStart[start];
  const charEnd = foldedChunk.sourceEnd[lastFoldedIndex];
  if (charStart === undefined || charEnd === undefined || charEnd <= charStart) {
    // Unreachable: a non-empty folded quote spans at least one original
    // character. Refusing to invent a span is still better than returning one.
    return NOT_FOUND_LOCATION;
  }
  return found(charStart, charEnd, "normalized");
}

/**
 * Locates `quote` in the first chunk of `chunks` that contains it whole.
 *
 * @param quote - The evidence text as the extractor produced it.
 * @param chunks - The document's chunks, in stored order.
 * @returns The matching chunk and its span, or `not_found`.
 */
export function locateQuoteInChunks(
  quote: string,
  chunks: readonly SourceChunk[],
): ChunkQuoteLocation {
  for (const chunk of chunks) {
    const location = locateQuote(quote, chunk.content);
    if (isLocatedQuote(location)) {
      return { status: "found", chunk, span: location.span };
    }
  }
  return NOT_FOUND_LOCATION;
}
