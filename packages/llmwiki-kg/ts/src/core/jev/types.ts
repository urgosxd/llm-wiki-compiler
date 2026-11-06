/**
 * @file packages/llmwiki-kg/ts/src/core/jev/types.ts
 * @description The JEV vocabulary: the documented System One wire shape, the
 * substitutable client interface, and the verdicts this application derives from it.
 *
 * ## JEV is a typed-decision API, not a text model
 *
 * Jev (TypeSafe AI "System One") answers typed questions about a `state`. One
 * `POST {baseUrl}/v1/systemone` carries a `model`, the `state`, and a map of
 * question id to question, and answers every one of them in a single response.
 * The two primitives this adapter uses are documented and only these are modelled:
 *
 * - `choice` — `{ type, instructions, criteria: { <optionName>: <description|null> } }`,
 *   at most {@link MAX_CHOICE_OPTIONS} options. Jev returns the argmax label plus
 *   the FULL `probabilities` distribution and a `confidence`.
 * - `noul` — `{ type, instructions, criteria: { true, false } }`. Jev returns one
 *   probability and NO `confidence`.
 *
 * There is no text/completion output, no batch endpoint, and no native abstain
 * flag. Nothing outside that contract is modelled here: a field the vendor does
 * not document is not a field this repository may read, so anything the pipeline
 * needs beyond the wire shape (`canonicalType`, identity, provenance) is ours and
 * lives on our side.
 *
 * ## `confidence` is not correctness
 *
 * The vendor documents `confidence` as a DERIVED dispersion measure over the
 * distribution, not the probability that the answer is right. It is preserved
 * verbatim in {@link JevChoiceReadout} under its own name, and no code in this
 * directory treats it as a correctness probability — S22 and S23 require the four
 * magnitudes (extraction confidence, source support, classification confidence,
 * human verification) to stay distinguishable, which they do by living in
 * different fields of different types.
 *
 * ## Why the failure variants are separate types
 *
 * S25 forbids turning a provider problem into `NO_MATCH`. A convention ("callers
 * must check for errors first") would not survive a refactor, so the outcome that
 * reaches interpretation is a union: {@link JevDecisionOutcome} is either an
 * `answered` response or a `provider_failure`, and only the `answered` arm carries
 * answers at all. There is no representable value that holds both "the provider
 * failed" and "nothing in the catalog fits".
 */

import { LlmError } from "../llm/errors.js";
import type { SupportState } from "../../schema-open-classification.js";

/** Path of the documented System One endpoint, appended to a base URL. */
export const JEV_SYSTEM_ONE_PATH = "/v1/systemone";

/**
 * The documented maximum number of options on one `choice` question.
 *
 * A catalog wider than this cannot be asked as a single question, and truncating
 * it would classify against a vocabulary nobody chose, so the builder refuses.
 */
export const MAX_CHOICE_OPTIONS = 255;

/** One documented `choice` question. */
export interface JevChoiceQuestion {
  readonly type: "choice";
  /** What the answer means, in language the decision model reads as the task. */
  readonly instructions: string;
  /** Option label to description; `null` is permitted by the vendor. */
  readonly criteria: Readonly<Record<string, string | null>>;
}

/**
 * One documented `noul` question: a yes/no question answered with a probability.
 *
 * The pair is declared in the order `true`, `false`, which is what lets
 * {@link JevNoulAnswer} carry a single number.
 */
export interface JevNoulQuestion {
  readonly type: "noul";
  /** The yes/no question, phrased so `true` means the option list fits. */
  readonly instructions: string;
  /** What `true` and `false` mean for this question. */
  readonly criteria: Readonly<Record<"true" | "false", string>>;
}

/** A question this adapter can ask. */
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

/**
 * One System One request.
 *
 * Many questions travel together, which is why no batching endpoint is needed:
 * a candidate's classification and its companion abstain question are asked in
 * the same call, and so are a whole chunk's candidates when a caller chooses to
 * group them.
 */
export interface JevDecisionRequest {
  /** Model id, e.g. `jev-latest`. */
  readonly model: string;
  /** The observed context the questions are asked about, as text. */
  readonly state: string;
  /** Question id to question; the ids come back as keys of `answers`. */
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

/** A documented `choice` answer: the argmax label, the full distribution, and `confidence`. */
export interface JevChoiceAnswer {
  readonly type: "choice";
  /** The highest-probability option label. */
  readonly choice: string;
  /** Every option's probability, as returned. Never recomputed here. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The vendor's derived dispersion measure. Not P(answer correct). */
  readonly confidence: number;
}

/** A documented `noul` answer: one probability, and deliberately no `confidence`. */
export interface JevNoulAnswer {
  readonly type: "noul";
  /** Probability of the `true` criterion of the paired question. */
  readonly noul: number;
}

/** An answer to one question. */
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

/**
 * One System One response.
 *
 * `usage` exists in the documented envelope but its shape is vendor-owned and not
 * consumed here, so it is typed as opaque and never read.
 */
export interface JevDecisionResponse {
  readonly model: string;
  /** Question id to answer. A question the vendor skipped is simply absent. */
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage?: unknown;
}

/**
 * The one method the rest of the pipeline depends on.
 *
 * Everything downstream is written against this interface, so the real HTTP
 * adapter, the scripted double, and any future in-process decision maker are
 * interchangeable, and a test can drive classification without a network or a
 * credential.
 */
export interface JevDecisionClient {
  /**
   * Asks Jev the request's questions.
   *
   * @param request - The state and questions to decide.
   * @returns The vendor-shaped response.
   * @throws {JevProviderError} when the provider failed, refused, or answered
   * something outside the documented shape.
   */
  decide(request: JevDecisionRequest): Promise<JevDecisionResponse>;
}

/**
 * Why a decision could not be used.
 *
 * - `provider_failed`    no usable answer reached us: transport failure,
 *   timeout, or every retry spent on a transient condition.
 * - `provider_answered`  the provider answered with an error status that will
 *   not change on retry (a bad credential, a malformed request).
 * - `invalid_response`   the provider answered 2xx with a body outside the
 *   documented shape, or a question the request asked went unanswered.
 *
 * The distinction is the one S25 needs: it says whether the extracted candidate
 * is waiting on an outage or on a configuration fix.
 */
export type JevFailureKind = "provider_failed" | "provider_answered" | "invalid_response";

/** The operational classification state a failure leaves behind. */
export type OperationalState = "pending" | "failed";

/**
 * The operational state a failure kind implies.
 *
 * `pending` is retryable: nothing about the request was wrong. `failed` needs a
 * human or a code change, because repeating the identical call cannot help.
 *
 * @param kind - Why the decision could not be used.
 * @returns The state the caller should store for the candidate.
 */
export function operationalStateFor(kind: JevFailureKind): OperationalState {
  return kind === "provider_failed" ? "pending" : "failed";
}

/**
 * A provider problem, typed so a caller never has to parse a message.
 *
 * Extends {@link LlmError} because that is the type the shared retry policy
 * classifies: an error with no HTTP status never got an answer and is worth
 * retrying, `429` and `5xx` are worth retrying, and every other status is a
 * refusal that a second identical request cannot fix.
 */
export class JevProviderError extends LlmError {
  /** Why the decision could not be used. */
  readonly kind: JevFailureKind;

  /**
   * @param kind - Why the decision could not be used.
   * @param message - What happened, with the endpoint and status named.
   * @param endpoint - The URL that was called.
   * @param status - The HTTP status, when the provider answered at all.
   */
  constructor(kind: JevFailureKind, message: string, endpoint: string, status?: number) {
    super(message, endpoint, status);
    this.name = "JevProviderError";
    this.kind = kind;
  }
}

/**
 * Raised when a request cannot be built as documented — a catalog too wide for
 * one `choice`, for instance. A build error is our bug, not a provider condition,
 * so it is not a {@link JevProviderError} and is never retried.
 */
export class JevQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevQuestionError";
  }
}

/** A decision the provider actually produced. */
export interface JevAnswered {
  readonly status: "answered";
  readonly response: JevDecisionResponse;
}

/**
 * No decision was produced.
 *
 * Carries no answers, no probabilities and no label: every field that could be
 * mistaken for a classification is absent by construction, so a caller cannot
 * read a provider failure as an abstention.
 */
export interface JevFailed {
  readonly status: "provider_failure";
  readonly kind: JevFailureKind;
  readonly state: OperationalState;
  readonly reason: string;
}

/** What one call to a {@link JevDecisionClient} produced. */
export type JevDecisionOutcome = JevAnswered | JevFailed;

/**
 * Narrows an outcome to the answered arm.
 *
 * @param outcome - The result of a decision call.
 * @returns True when the provider produced an answer to interpret.
 */
export function isAnswered(outcome: JevDecisionOutcome): outcome is JevAnswered {
  return outcome.status === "answered";
}

/**
 * The ids and namespace of one classification question set.
 *
 * `namespace` is explicit because entity types and relation types are separate
 * catalogs: resolving a relation label against the entity namespace would be a
 * silent collision, and it is exactly the kind of mistake a shared id string
 * invites.
 */
export interface ClassificationQuestionSet {
  /** Which catalog namespace the chosen label must resolve in. */
  readonly namespace: "entity" | "relation";
  /** Question id of the `choice` over canonical types. */
  readonly choice: string;
  /** Question id of the companion `noul` asking whether any type fits. */
  readonly fits: string;
}

/**
 * The vendor's raw `choice` answer, preserved with its original meaning.
 *
 * `confidence` keeps the vendor's own name because renaming it is how a dispersion
 * measure becomes a fake probability of correctness. `topProbability` is read out
 * of the distribution rather than taken on faith, so a distribution that omits its
 * own argmax is detected instead of assumed.
 */
export interface JevChoiceReadout {
  /** The argmax label the vendor returned. Not a canonical type until resolved. */
  readonly choice: string;
  /** Every option's probability, verbatim. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The vendor's `confidence`: a derived dispersion measure, not correctness. */
  readonly confidence: number;
  /** `probabilities[choice]`, the weight the argmax actually holds. */
  readonly topProbability: number;
  /** The model that produced the answer, as echoed in the response. */
  readonly model: string;
}

/** A candidate that resolved to exactly one canonical catalog type. */
export interface ClassifiedVerdict {
  readonly status: "classified";
  /** The canonical spelling of the type the candidate belongs to. */
  readonly canonicalType: string;
  /** Probability of the paired `noul` question, i.e. "some catalog type fits". */
  readonly fitsProbability: number;
  readonly readout: JevChoiceReadout;
}

/**
 * A candidate the classifier judged outside the catalog: free by absence of a match.
 *
 * Deliberately carries no `canonicalType`. "Free" means no catalog type was
 * assigned; it does not mean false, invalid or awaiting review.
 */
export interface NoMatchVerdict {
  readonly status: "free_no_match";
  readonly fitsProbability: number;
  readonly reason: string;
  readonly readout: JevChoiceReadout;
}

/** A candidate the classifier could not decide: free by ambiguity, not by absence. */
export interface UncertainVerdict {
  readonly status: "free_uncertain";
  readonly fitsProbability: number;
  readonly reason: string;
  readonly readout: JevChoiceReadout;
}

/** A candidate whose classification could not be evaluated at all. */
export interface OperationalFailureVerdict {
  readonly status: "operational_failure";
  readonly state: OperationalState;
  readonly kind: JevFailureKind;
  readonly reason: string;
}

/** The result of interpreting one classification decision. */
export type ClassificationVerdict =
  | ClassifiedVerdict
  | NoMatchVerdict
  | UncertainVerdict
  | OperationalFailureVerdict;

/**
 * The two support states a classifier can actually decide.
 *
 * Narrower than {@link SupportState} on purpose: `uncertain` is not a decision, it
 * is the band where neither direction dominates, and it travels in its own verdict
 * so a consumer cannot read "no dominant answer" as "the classifier said uncertain
 * with confidence".
 */
export type DecidedSupportState = Extract<SupportState, "supported" | "unsupported">;

/** A semantic-support verdict the classifier actually decided. */
export interface DecidedSupportVerdict {
  /** S20's closed set in the spelling the storage column uses. */
  readonly status: DecidedSupportState;
  readonly readout: JevChoiceReadout;
}

/** A support question that could not be decided because no type dominates. */
export interface UncertainSupportVerdict {
  readonly status: "uncertain";
  readonly reason: string;
  readonly readout: JevChoiceReadout;
}

/** The result of interpreting one semantic-support decision. */
export type SupportVerdict =
  | DecidedSupportVerdict
  | UncertainSupportVerdict
  | OperationalFailureVerdict;
