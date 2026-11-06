/**
 * @file packages/llmwiki-kg/ts/src/core/jev/interpret.ts
 * @description Turning one vendor answer into one of our verdicts, without ever
 * lending a provider problem the authority of a catalog judgement.
 *
 * ## The classification rule, in order
 *
 * 1. The provider never answered → `operational_failure` (S25). Nothing else is
 *    read, so no answer path exists that could produce `NO_MATCH` from a failure.
 * 2. The answer set is missing a question we asked → `operational_failure` with
 *    kind `invalid_response`. A missing companion `noul` is NOT "no match".
 * 3. P(a catalog type fits) below the no-match band → `free_no_match`.
 * 4. P(a catalog type fits) inside the uncertain band → `free_uncertain`: the
 *    catalog fit itself is what is uncertain.
 * 5. The chosen label is not a declared type → `operational_failure`. Jev was told
 *    to pick from the criteria, so a label outside them is a defect, not an
 *    abstention, and guessing a nearby type would be worse than reporting it.
 * 6. P(the argmax type) below `classificationMinTopProbability` → `free_uncertain`:
 *    a real choice was made, but no type dominates it.
 * 7. Otherwise → `classified`, carrying the raw choice, the full distribution, the
 *    vendor `confidence` and the top probability untouched.
 *
 * ## Why `confidence` decides nothing
 *
 * The vendor documents `confidence` as a derived dispersion measure, not the
 * probability that the answer is correct. Every band above is therefore defined
 * over probabilities Jev actually reports as probabilities. The vendor's
 * `confidence` travels in the readout so an auditor can read it, and no branch in
 * this file reads it — which is how S22 and S23 stay true after the code changes.
 *
 * ## Support is interpreted separately
 *
 * {@link interpretSupport} shares the readout and the failure handling and nothing
 * else: it never sees a classification answer, so a confident label can never make
 * a claim look supported.
 */

import { resolveEntityType, resolveRelationType } from "../catalog/lookup.js";
import type { TypeCatalog } from "../catalog/types.js";
import type { JevThresholds } from "./config.js";
import { SUPPORT_CHOICE_LABELS, SUPPORT_QUESTION_ID } from "./questions.js";
import { operationalStateFor } from "./types.js";
import type {
  ClassificationQuestionSet,
  ClassificationVerdict,
  DecidedSupportVerdict,
  JevChoiceAnswer,
  JevChoiceReadout,
  JevDecisionOutcome,
  JevDecisionResponse,
  JevFailed,
  OperationalFailureVerdict,
  SupportVerdict,
} from "./types.js";

/** Why a candidate was judged outside the catalog. */
export const CLASSIFICATION_REASON_NO_MATCH =
  "the companion noul put P(some catalog type fits) below the configured no-match band";

/** Why a candidate's catalog fit is still open. */
export const CLASSIFICATION_REASON_UNCERTAIN_FIT =
  "P(some catalog type fits) sits inside the configured uncertain band, so the fit itself is ambiguous";

/** Why a candidate with a chosen label is still free. */
export const CLASSIFICATION_REASON_UNCERTAIN_TOP =
  "no catalog type dominates the distribution: the top probability is below the configured minimum";

/** Why a support judgement came back undecided. */
export const SUPPORT_REASON_UNCERTAIN =
  "neither support direction dominates: the top probability is below the configured support band";

/** Everything interpretation needs, besides the outcome itself. */
export interface ClassificationInterpretationOptions {
  /** The catalog the chosen label must resolve in. */
  readonly catalog: TypeCatalog;
  /** The configured confidence bands. */
  readonly thresholds: JevThresholds;
  /** Which questions were asked, and in which namespace to resolve the answer. */
  readonly questions: ClassificationQuestionSet;
}

/**
 * Reads the vendor's raw answer into our readout, refusing an inconsistent one.
 *
 * @param answer - The validated `choice` answer.
 * @param model - The model the response echoed.
 * @returns The readout, or `undefined` when the distribution omits its own argmax.
 */
function readoutOf(answer: JevChoiceAnswer, model: string): JevChoiceReadout | undefined {
  const topProbability = answer.probabilities[answer.choice];
  if (topProbability === undefined) return undefined;
  return Object.freeze({
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    topProbability,
    model,
  });
}

/**
 * Resolves a chosen label in the question set's catalog namespace.
 *
 * @param catalog - The catalog in force.
 * @param namespace - Which namespace the label belongs to.
 * @param label - The label the vendor chose.
 * @returns The canonical spelling, or `undefined` when nothing declares the label.
 */
function canonicalTypeOf(catalog: TypeCatalog, namespace: "entity" | "relation", label: string): string | undefined {
  const definition =
    namespace === "entity" ? resolveEntityType(catalog, label) : resolveRelationType(catalog, label);
  return definition?.name;
}

/**
 * Builds the operational-failure verdict for a call that produced no answer.
 *
 * @param failure - The failed outcome from the client boundary.
 * @returns The verdict, carrying the state the caller must store.
 */
function failureVerdict(failure: JevFailed): OperationalFailureVerdict {
  return { status: "operational_failure", state: failure.state, kind: failure.kind, reason: failure.reason };
}

/**
 * Builds the operational-failure verdict for a payload this adapter refused.
 *
 * @param reason - What was wrong, named for the operator who will read the log.
 * @returns The verdict, always `failed` because retrying cannot fix it.
 */
function invalidVerdict(reason: string): OperationalFailureVerdict {
  return { status: "operational_failure", state: operationalStateFor("invalid_response"), kind: "invalid_response", reason };
}

/**
 * Interprets one classification decision.
 *
 * @param outcome - What the client boundary produced.
 * @param options - Catalog, thresholds and the questions that were asked.
 * @returns A calibrated classification verdict, never `NO_MATCH` for a failure.
 */
export function interpretClassification(
  outcome: JevDecisionOutcome,
  options: ClassificationInterpretationOptions,
): ClassificationVerdict {
  if (outcome.status === "provider_failure") return failureVerdict(outcome);
  const response: JevDecisionResponse = outcome.response;
  const choice = response.answers[options.questions.choice];
  const fits = response.answers[options.questions.fits];
  if (choice === undefined || choice.type !== "choice") {
    return invalidVerdict(`the response has no choice answer for question ${options.questions.choice}`);
  }
  if (fits === undefined || fits.type !== "noul") {
    return invalidVerdict(`the response has no noul answer for question ${options.questions.fits}`);
  }
  const readout = readoutOf(choice, response.model);
  if (readout === undefined) {
    return invalidVerdict(`the chosen label ${JSON.stringify(choice.choice)} is absent from its own distribution`);
  }
  const fitsProbability = fits.noul;
  if (fitsProbability < options.thresholds.classificationNoMatchBelow) {
    return { status: "free_no_match", fitsProbability, reason: CLASSIFICATION_REASON_NO_MATCH, readout };
  }
  if (fitsProbability < options.thresholds.classificationUncertainBelow) {
    return { status: "free_uncertain", fitsProbability, reason: CLASSIFICATION_REASON_UNCERTAIN_FIT, readout };
  }
  const canonicalType = canonicalTypeOf(options.catalog, options.questions.namespace, choice.choice);
  if (canonicalType === undefined) {
    return invalidVerdict(
      `the chosen label ${JSON.stringify(choice.choice)} is not a declared ${options.questions.namespace} type`,
    );
  }
  if (readout.topProbability < options.thresholds.classificationMinTopProbability) {
    return { status: "free_uncertain", fitsProbability, reason: CLASSIFICATION_REASON_UNCERTAIN_TOP, readout };
  }
  return { status: "classified", canonicalType, fitsProbability, readout };
}

/**
 * Maps a support option label onto its stored spelling.
 *
 * @param label - The label the vendor chose.
 * @returns `supported`, `unsupported`, or `undefined` when it is neither.
 */
function supportStateOf(label: string): "supported" | "unsupported" | undefined {
  if (label === SUPPORT_CHOICE_LABELS.supported) return "supported";
  if (label === SUPPORT_CHOICE_LABELS.unsupported) return "unsupported";
  return undefined;
}

/**
 * Interprets one semantic-support decision.
 *
 * @param outcome - What the client boundary produced.
 * @param thresholds - The configured bands.
 * @returns Whether the quote supports the claim, or why that is undecided.
 */
export function interpretSupport(outcome: JevDecisionOutcome, thresholds: JevThresholds): SupportVerdict {
  if (outcome.status === "provider_failure") return failureVerdict(outcome);
  const answer = outcome.response.answers[SUPPORT_QUESTION_ID];
  if (answer === undefined || answer.type !== "choice") {
    return invalidVerdict(`the response has no choice answer for question ${SUPPORT_QUESTION_ID}`);
  }
  const readout = readoutOf(answer, outcome.response.model);
  if (readout === undefined) {
    return invalidVerdict(`the chosen label ${JSON.stringify(answer.choice)} is absent from its own distribution`);
  }
  const decided = supportStateOf(readout.choice);
  if (decided === undefined) {
    return invalidVerdict(`the chosen label ${JSON.stringify(readout.choice)} is not one of the support options offered`);
  }
  if (readout.topProbability < thresholds.supportUncertainBelow) {
    return { status: "uncertain", reason: SUPPORT_REASON_UNCERTAIN, readout };
  }
  const verdict: DecidedSupportVerdict = { status: decided, readout };
  return verdict;
}
