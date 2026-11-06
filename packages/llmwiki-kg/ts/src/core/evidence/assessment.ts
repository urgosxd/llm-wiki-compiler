/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/assessment.ts
 * @description Attaching the one judgement this stage cannot make, without ever
 * letting it stand in for the one it can.
 *
 * ## What this file enforces
 *
 * `locate.ts` answers "does the quote exist in the source". A classifier — not
 * this module — answers "does that quote support the claim" (S12, S20). The link
 * between them is an {@link EvidenceAssessment}: two named fields, two unrelated
 * types, so `quote` can never be read as if it were `support`.
 *
 * The invariant that keeps the distinction real is construction, not
 * documentation: {@link withSupport} takes the assessment and refuses when the
 * quote was never located. A support verdict for text nobody found would assert
 * something about the source while pointing at nothing — precisely the silent
 * degradation the stage exists to prevent — so it is an
 * {@link EvidenceStageError}, not a coerced `not_found`.
 *
 * ## Unjudged is its own state
 *
 * `support: null` means "the caller has not judged this", which is not
 * `uncertain`: `uncertain` is a classifier's answer that it could not decide, and
 * collapsing the two would attribute an evaluation that never happened.
 */

import { EvidenceStageError, isLocatedQuote } from "./types.js";
import type { EvidenceKind, QuoteLocation, SupportState } from "./types.js";

/**
 * A caller-supplied judgement that the located quote supports the claim.
 *
 * `verdict` reuses the schema's `SupportState` (`supported` / `unsupported` /
 * `uncertain`) so the value stored in `kg_evidence.evidence_kind = 'semantic'`
 * rows keeps the closed set S20 defines.
 */
export interface SemanticSupport {
  /** The classifier's answer about meaning, never about presence. */
  readonly verdict: SupportState;
  /** Who produced the verdict: a model id or a human reviewer id. */
  readonly assessedBy: string;
  /** Why, when the provider returns a reason; null when it does not. */
  readonly rationale: string | null;
}

/**
 * Everything the evidence stage knows about one candidate span.
 *
 * A quote that exists but is judged `unsupported` is a normal, representable
 * value here — that combination is the whole point of S12.
 */
export interface EvidenceAssessment {
  /** Whether the quote exists in the source. Answerable by `locate.ts` alone. */
  readonly quote: QuoteLocation;
  /** Whether that quote supports the claim. Supplied by the caller; null when unjudged. */
  readonly support: SemanticSupport | null;
}

/**
 * Wraps a locator result with an explicit "not judged yet" support field.
 *
 * @param quote - The result of locating the quote.
 * @returns The assessment, with no support verdict attached.
 */
export function assessQuote(quote: QuoteLocation): EvidenceAssessment {
  return Object.freeze({ quote, support: null });
}

/**
 * Attaches a semantic support verdict to an assessment whose quote was located.
 *
 * @param assessment - The evidence assessment being completed.
 * @param support - The caller's judgement about meaning.
 * @returns A new frozen assessment carrying both facts.
 * @throws {EvidenceStageError} when the quote was not located in the source.
 */
export function withSupport(
  assessment: EvidenceAssessment,
  support: SemanticSupport,
): EvidenceAssessment {
  if (!isLocatedQuote(assessment.quote)) {
    throw new EvidenceStageError(
      "cannot record semantic support for a quote that was not located in the source",
    );
  }
  return Object.freeze({ quote: assessment.quote, support: Object.freeze({ ...support }) });
}

/**
 * Whether the source was actually found to contain the quote.
 *
 * Named so a caller reads a fact about presence and cannot mistake it for a
 * support verdict.
 *
 * @param assessment - The evidence assessment to inspect.
 * @returns True when the quote was located in the source.
 */
export function hasTextualEvidence(assessment: EvidenceAssessment): boolean {
  return isLocatedQuote(assessment.quote);
}

/**
 * The support verdict, or null when the span has not been judged.
 *
 * @param assessment - The evidence assessment to inspect.
 * @returns The verdict, or null.
 */
export function supportVerdict(assessment: EvidenceAssessment): SupportState | null {
  return assessment.support === null ? null : assessment.support.verdict;
}

/**
 * Which `kg_evidence.evidence_kind` this assessment produces.
 *
 * @param assessment - The evidence assessment to inspect.
 * @returns `semantic` once a support verdict exists, `textual` before that.
 */
export function evidenceKindOf(assessment: EvidenceAssessment): EvidenceKind {
  return assessment.support === null ? "textual" : "semantic";
}
