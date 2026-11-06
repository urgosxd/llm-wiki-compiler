/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/support-stage.ts
 * @description Stage 2b: asking the classifier whether a located quote SUPPORTS the
 * claim made from it (S12, S19, S20).
 *
 * ## Two questions, never one
 *
 * `candidates.ts` answers "does the source contain these words" by locating the
 * quote, and that answer is a fact about presence. This stage asks the other
 * question — "do those words back the claim?" — which no amount of string matching
 * can settle: a quote can exist, be about something else, and still be cited
 * (`S12`: "Una cita existente no garantiza que respalde la interpretación del
 * extractor").
 *
 * The two answers are stored in two places on purpose: presence becomes a `textual`
 * `kg_evidence` row, and this verdict becomes a `semantic` one plus the row's
 * `support_state`. Collapsing them into one field would make an unlocated quote and
 * an unsupporting one indistinguishable.
 *
 * ## What is asked, and what is deliberately not
 *
 * A quote the source does not contain gets NO question. Asking would invite the
 * classifier to judge text nobody produced, and the honest record of that span is
 * the absence itself: `support_state` NULL, one `textual` evidence row, no verdict
 * invented (S23).
 *
 * A provider failure is ALSO no verdict. `requestDecision` turns an outage into an
 * outcome instead of throwing, and this stage simply leaves the judgement absent:
 * an answered-with-failure run must never read as "the classifier said the quote
 * does not support the claim".
 *
 * ## The claim is the candidate restated, in words the classifier can judge
 *
 * Built from the candidate's own fields and nothing else — no document prose, no
 * catalog description — so the question is comparable across candidates and cannot
 * smuggle in an interpretation the extractor did not make. `core/evidence/
 * prompt-data.ts` keeps the document side framed as data (S13).
 *
 * ## No database, no transaction
 *
 * The stage takes spans and a runtime, and returns verdicts. It runs beside the
 * classification stage, outside any transaction, for the same reason (S44).
 */

import type { KnowledgeCandidate } from "../../core/candidates/types.js";
import { requestDecision } from "../../core/jev/client.js";
import { interpretSupport } from "../../core/jev/interpret.js";
import { buildSupportRequest } from "../../core/jev/questions.js";
import type { SupportVerdict } from "../../core/jev/types.js";
import { hasTextualEvidence } from "../../core/evidence/assessment.js";
import type { SemanticSupport } from "../../core/evidence/assessment.js";
import type { ClassificationRuntime } from "./classify-stage.js";
import type { CandidateSpan } from "./candidates.js";

/** The semantic judgement per candidate ref; a ref absent from it was never judged. */
export type SupportJudgements = ReadonlyMap<string, SemanticSupport>;

/** One unit of work: the spans stage 2 produced and the runtime that answers. */
export interface SupportStageInput {
  readonly spans: readonly CandidateSpan[];
  readonly runtime: ClassificationRuntime;
}

/**
 * The claim the support question asks about, built from the candidate alone.
 *
 * An entity's claim names the entity and the type the extractor proposed for it;
 * a relation's claim is the assertion itself. `proposedType` is omitted rather than
 * rendered as `null` when the extractor proposed nothing, so the question never
 * shows a reader a value that was never asserted.
 *
 * @param candidate - One entity or relation candidate.
 * @returns The claim, in one line.
 */
export function claimOf(candidate: KnowledgeCandidate): string {
  if (candidate.kind === "entity") {
    return candidate.proposedType === null
      ? `the entity "${candidate.name}"`
      : `the entity "${candidate.name}" is of type "${candidate.proposedType}"`;
  }
  return `"${candidate.fromName}" ${candidate.predicate} "${candidate.toName}"`;
}

/**
 * Turns one interpreted support decision into the recorded judgement.
 *
 * @param verdict - What `interpretSupport` decided.
 * @returns The judgement, or `undefined` when the question was not answered.
 */
function judgementOf(verdict: SupportVerdict): SemanticSupport | undefined {
  if (verdict.status === "operational_failure") {
    // Unanswered, which is not a judgement about the source: no entry, no row, and
    // the column stays NULL (S23, S25).
    return undefined;
  }
  const rationale = verdict.status === "uncertain" ? verdict.reason : null;
  return { verdict: verdict.status, assessedBy: verdict.readout.model, rationale };
}

/**
 * Asks the support question for every candidate whose quote was located.
 *
 * Spans are visited in candidate order (entities first, then relations), which is
 * what makes the request sequence deterministic and a scripted double able to
 * answer position by position.
 *
 * @param input - The spans and the decision runtime.
 * @returns One judgement per ANSWERED candidate, keyed by its ref.
 */
export async function assessSupport(input: SupportStageInput): Promise<SupportJudgements> {
  const judgements = new Map<string, SemanticSupport>();
  for (const span of input.spans) {
    if (!hasTextualEvidence(span.assessment)) continue;
    const request = buildSupportRequest({
      claim: claimOf(span.candidate),
      evidenceQuote: span.provenance.evidenceText,
      context: span.context,
      model: input.runtime.config.model,
    });
    const verdict = interpretSupport(
      await requestDecision(input.runtime.client, request),
      input.runtime.config.thresholds,
    );
    const judgement = judgementOf(verdict);
    if (judgement !== undefined) judgements.set(span.candidate.ref, judgement);
  }
  return judgements;
}

/**
 * The support state per candidate ref, which is what the classification stage takes.
 *
 * @param judgements - The semantic judgements.
 * @returns A plain record of `supported` / `unsupported` / `uncertain` by ref.
 */
export function supportStatesOf(
  judgements: SupportJudgements,
): Readonly<Record<string, "supported" | "unsupported" | "uncertain">> {
  return Object.fromEntries(
    [...judgements].map(([ref, judgement]) => [ref, judgement.verdict]),
  );
}
