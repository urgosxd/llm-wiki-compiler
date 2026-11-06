/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/types.ts
 * @description The vocabulary of the evidence stage: a located quote, and the
 * separate judgement of whether that quote supports the claim.
 *
 * ## Two questions, two fields, two types
 *
 * S12 of the feature (`Una cita existente no garantiza que respalde la
 * interpretación del extractor`) names a distinction that is easy to erase by
 * accident: whether a quote EXISTS in the source and whether it SUPPORTS the
 * extractor's reading are different facts. This module can answer only the first.
 * The types keep them apart three ways, so nobody can read presence as support:
 *
 * 1. Different field names — `quote` versus `support`, never one boolean.
 * 2. Different types — {@link QuoteLocation} is a locator result;
 *    {@link SupportState} is a judgement about meaning borrowed from the schema.
 * 3. Different construction — a support verdict can only be attached to a
 *    location that was actually found (`withSupport` in `assessment.ts`).
 *
 * ## Absence is a recorded fact, not an error
 *
 * `not_found` is a successful answer. A caller must be able to store "the quote
 * is not in this chunk" — that is what makes a weak candidate visible instead of
 * hidden — so nothing here throws for an absent quote.
 */

import type { CandidateKind, EvidenceKind, SupportState } from "../../schema-open-classification.js";

export type { CandidateKind, EvidenceKind, SupportState };

/**
 * How a quote was matched against the chunk text.
 *
 * - `exact`      the quote occurs verbatim in the chunk.
 * - `normalized` it occurs only after the controlled folds in `normalize.ts`.
 */
export type QuoteMatchKind = "exact" | "normalized";

/**
 * A verifiable span of the ORIGINAL chunk text.
 *
 * `charStart`/`charEnd` are UTF-16 character offsets into the chunk content as
 * stored, never into a folded copy and never into the source file. They satisfy
 * `char_start >= 0` and `char_end > char_start`, which is the constraint
 * `kg_evidence` enforces on insert.
 */
export interface QuoteSpan {
  /** Offset of the first matched character, inclusive. */
  readonly charStart: number;
  /** Offset one past the last matched character, exclusive. */
  readonly charEnd: number;
  /** Whether the match needed normalization. */
  readonly match: QuoteMatchKind;
}

/** A quote that was located in the chunk text. */
export interface LocatedQuote {
  readonly status: "found";
  readonly span: QuoteSpan;
}

/**
 * A quote that is NOT in the chunk text.
 *
 * Deliberately carries no span and no partial match: the honest answer is
 * "absent", and approximating it with a nearby span or a similarity score would
 * turn a missing citation into a seemingly verified one.
 */
export interface AbsentQuote {
  readonly status: "not_found";
}

/** The answer to "does this quote exist in the source". */
export type QuoteLocation = LocatedQuote | AbsentQuote;

/** The shared `not_found` value; frozen, because callers compare by identity. */
export const NOT_FOUND_LOCATION: AbsentQuote = Object.freeze({ status: "not_found" });

/**
 * Raised when the evidence stage is asked for something it cannot honestly
 * produce, such as a support verdict for a quote that was never located.
 */
export class EvidenceStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStageError";
  }
}

/**
 * Narrows a location to the found case.
 *
 * @param location - Any locator result.
 * @returns True when the quote was located.
 */
export function isLocatedQuote(location: QuoteLocation): location is LocatedQuote {
  return location.status === "found";
}
