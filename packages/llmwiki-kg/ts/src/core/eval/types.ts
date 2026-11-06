/**
 * @file packages/llmwiki-kg/ts/src/core/eval/types.ts
 * @description The labeled-set model and the four-axis report, kept apart on purpose.
 *
 * ## Why the report has four axes and no total
 *
 * An ingestion run can be wrong in four independent places, and each one needs its
 * own denominator:
 *
 * - **extractor coverage** — did the extractor produce the fact at all? A fact it
 *   never produced is invisible to every later stage. JEV cannot recover a
 *   candidate the extractor omitted, so this number can never be folded into, or
 *   compared against, a classifier score.
 * - **classifier quality** — given a candidate, did the canonical label come out
 *   right, and when it did not, was the mistake a wrong type, a refusal to choose
 *   when a type existed, or a confident choice where abstaining was correct?
 * - **support quality** — did the classifier judge the quoted evidence as backing
 *   the claim, or the other way round? A quote that exists is not a quote that
 *   supports (S12).
 * - **information loss** — how much of the extracted work never reached a decision
 *   (`pending` / `failed`) and how much was left free although a canonical label
 *   existed.
 *
 * There is deliberately no aggregate `score` field anywhere in {@link EvalReport}:
 * one number over four denominators invites exactly the reading S47 forbids — that
 * a classifier is "82% good" when the extractor dropped a third of the facts.
 *
 * ## The labels are the truth, the recorded answers are not
 *
 * `labels.canonical` and `labels.support` are human labels. `recorded` is a snapshot
 * of one illustrative decision run, kept so the offline runner exercises the real
 * adapter path with no network. Nothing in this directory ever compares `recorded`
 * against the labels to decide a metric; it feeds the double and the labels judge it.
 *
 * ## Shape of one example
 *
 * Every example carries all four things a measurement needs: the source passage,
 * the claim under review, the candidate the extractor emitted (or the fact it never
 * emitted), and both labels. `extracted: false` is a first-class case, not a hole:
 * it is the only way to say "this fact was in the document and the extractor never
 * produced it", which is the whole point of measuring coverage separately.
 */

import type { CandidateDecision } from "../classify/types.js";
import type { SupportVerdict } from "../jev/types.js";

/** The human label meaning "no catalog type describes this candidate". */
export const NO_MATCH_LABEL = "NO_MATCH";

/** The human label meaning "the catalog fit is genuinely ambiguous here". */
export const UNCERTAIN_LABEL = "UNCERTAIN";

/** The languages the shipped set uses; this project's domain reads both. */
export type LabeledLanguage = "es" | "en";

/** The human judgement on whether the quoted source supports the claim. */
export type SupportLabel = "supported" | "unsupported";

/** The fact a human expects to see in the graph, for an entity. */
export interface LabeledEntityFact {
  readonly name: string;
}

/** The fact a human expects to see in the graph, for a relation. */
export interface LabeledRelationFact {
  readonly from: string;
  /** The predicate as the document phrased it. Never a canonical verb. */
  readonly predicate: string;
  readonly to: string;
}

/** The candidate an entity extractor emitted. */
export interface EntityCandidateSpec {
  readonly name: string;
  /** The type the extractor proposed, or `null` when it proposed none. */
  readonly proposedType: string | null;
}

/** The candidate a relation extractor emitted. */
export interface RelationCandidateSpec {
  readonly from: string;
  /** The original predicate, verbatim. */
  readonly predicate: string;
  readonly to: string;
  /** The relation type the extractor proposed, or `null` when it proposed none. */
  readonly proposedType: string | null;
}

/** Both human labels of one example. */
export interface ExampleLabels {
  /** A canonical catalog type, or {@link NO_MATCH_LABEL} / {@link UNCERTAIN_LABEL}. */
  readonly canonical: string;
  readonly support: SupportLabel;
}

/** Fields every example carries, whatever its kind. */
export interface ExampleBase {
  /** Stable identifier, used as the candidate ref inside one run. */
  readonly id: string;
  readonly language: LabeledLanguage;
  /** The document passage the claim was read from. */
  readonly source: string;
  /** The span the extractor cited as evidence. */
  readonly quote: string;
  /** The claim under review, as the support question asks about it. */
  readonly claim: string;
  /** Whether the extractor produced the candidate for this fact. */
  readonly extracted: boolean;
  readonly labels: ExampleLabels;
}

/** A recorded `choice` answer for one classification question. */
export interface RecordedClassification {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  /** The vendor's dispersion measure, carried verbatim. Not correctness. */
  readonly confidence: number;
  /** The companion `noul` probability: "some catalog option fits". */
  readonly fits: number;
}

/** A recorded provider failure, so the offline set can measure information loss. */
export interface RecordedFailure {
  readonly failure: "provider_failed";
}

/** A recorded `choice` answer for the support question. */
export interface RecordedSupport {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

/** The answers one illustrative run produced for one example. */
export interface RecordedAnswers {
  readonly classification: RecordedClassification | RecordedFailure;
  readonly support?: RecordedSupport;
}

/** One labeled entity example. */
export interface EntityExample extends ExampleBase {
  readonly kind: "entity";
  /** The fact a human expects; required when the extractor omitted it. */
  readonly fact?: LabeledEntityFact;
  readonly candidate?: EntityCandidateSpec;
  readonly recorded?: RecordedAnswers;
}

/** One labeled relation example. */
export interface RelationExample extends ExampleBase {
  readonly kind: "relation";
  /** The fact a human expects; required when the extractor omitted it. */
  readonly fact?: LabeledRelationFact;
  readonly candidate?: RelationCandidateSpec;
  readonly recorded?: RecordedAnswers;
}

/** One labeled example of either kind. */
export type LabeledExample = EntityExample | RelationExample;

/** The whole labeled set, versioned so a metric can be attributed to it. */
export interface EvalSet {
  readonly version: string;
  readonly examples: readonly LabeledExample[];
}

/** Which runner produced a report, and where it pointed. */
export interface RunInfo {
  readonly mode: "offline" | "real";
  /** The model id the run used, or the recorded model id for the offline double. */
  readonly model: string;
  /** The System One base URL, or `null` when no endpoint was contacted. */
  readonly baseUrl: string | null;
}

/** The six cells the classifier axis distinguishes. */
export interface ConfusionBreakdown {
  /** Chose the canonical type the human labeled. */
  readonly correctCanonicalType: number;
  /** Stayed free, and free was the right answer. */
  readonly correctAbstention: number;
  /** Chose a canonical type, but a different one than the human labeled. */
  readonly wrongCanonicalType: number;
  /** Stayed free although a canonical type existed. */
  readonly abstainedWhenTypeExisted: number;
  /** Asserted a type where the correct answer was `NO_MATCH` or `UNCERTAIN`. */
  readonly classifiedWhenNotDecidable: number;
  /** Stayed free for the wrong reason (`NO_MATCH` vs `UNCERTAIN`). */
  readonly abstentionReasonMismatch: number;
}

/** Classifier quality: measured only over candidates a classifier actually judged. */
export interface ClassificationMetrics {
  /** Candidates with a decision that was not an operational state. */
  readonly evaluated: number;
  readonly correct: number;
  /** `correct / evaluated`, or 0 when nothing was evaluated. */
  readonly accuracy: number;
  /** Free verdicts among the evaluated candidates. */
  readonly abstentions: number;
  readonly abstentionRate: number;
  readonly confusion: ConfusionBreakdown;
}

/** Support quality: measured only over examples whose quote was put to the classifier. */
export interface SupportMetrics {
  /** Judged examples whose support answer was decided (not undecided, not absent). */
  readonly judged: number;
  readonly correct: number;
  /** `correct / judged`, or 0 when nothing was judged. */
  readonly accuracy: number;
  /** Judged `supported` although the quote does not support the claim. */
  readonly falseSupport: number;
  /** Judged `unsupported` although the quote does support the claim. */
  readonly missedSupport: number;
  /** Neither support direction dominated. */
  readonly undecided: number;
  /** No verdict at all: the provider failed, or the quote was never judged. */
  readonly unjudged: number;
}

/** How much extracted work never reached a decision, or reached a free one. */
export interface InformationLossMetrics {
  /** Candidates the extractor produced, i.e. everything a classifier could see. */
  readonly candidates: number;
  /** Candidates left `pending` or `failed`: never evaluated by the classifier. */
  readonly notEvaluated: number;
  readonly pending: number;
  readonly failed: number;
  /** Candidates left free although a canonical label existed. */
  readonly freeWhenLabelExisted: number;
  /** `(notEvaluated + freeWhenLabelExisted) / candidates`. */
  readonly lossRate: number;
}

/** Extractor coverage, on its own axis and its own denominator. */
export interface ExtractorCoverageMetrics {
  /** Every fact the set labels. */
  readonly labeledFacts: number;
  /** Facts the extractor actually produced a candidate for. */
  readonly produced: number;
  /** Facts the extractor never produced; JEV never saw them. */
  readonly omitted: number;
  readonly omittedIds: readonly string[];
  /** `produced / labeledFacts`. */
  readonly coverageRate: number;
}

/** One example's observed outcome in a run, joined to its labels by id. */
export interface ObservedDecision {
  readonly exampleId: string;
  /** The classifier's decision, or `null` when the extractor produced no candidate. */
  readonly decision: CandidateDecision | null;
  /** The support verdict, or `null` when no verdict was produced. */
  readonly support: SupportVerdict | null;
}

/** Everything one scoring pass produced. Four axes, no aggregate. */
export interface EvalReport {
  readonly setVersion: string;
  readonly catalogVersion: string;
  readonly run: RunInfo;
  readonly classification: ClassificationMetrics;
  readonly support: SupportMetrics;
  readonly informationLoss: InformationLossMetrics;
  readonly extractorCoverage: ExtractorCoverageMetrics;
}
