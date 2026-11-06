/**
 * @file packages/llmwiki-kg/ts/src/core/eval/scorer.ts
 * @description The arithmetic: four axes, each with its own denominator, no total.
 *
 * ## Where each observation lands, and why it lands nowhere else
 *
 * | Observation | Axis | Cell |
 * | --- | --- | --- |
 * | No candidate (extractor miss) | extractor coverage | `omitted` |
 * | `pending` / `failed` | information loss | `notEvaluated` |
 * | Chose the labeled canonical type | classifier | `correctCanonicalType` |
 * | Chose another canonical type | classifier | `wrongCanonicalType` |
 * | Stayed free although a type existed | classifier AND information loss | `abstainedWhenTypeExisted` / `freeWhenLabelExisted` |
 * | Asserted a type where the label was `NO_MATCH` / `UNCERTAIN` | classifier | `classifiedWhenNotDecidable` |
 * | Stayed free for the wrong reason | classifier | `abstentionReasonMismatch` |
 * | Support verdict against the label | support | `falseSupport` / `missedSupport` |
 *
 * The fourth row is the only one counted on two axes, and both counts are named: it
 * is a classifier mistake (the classifier had a candidate and did not use it) and it
 * is also loss of information (the graph shows a free item where a canonical type
 * was available). Nothing else is double-counted, and no cell is ever summed with a
 * cell from another axis.
 *
 * ## Why an extractor miss is never a classifier error
 *
 * A fact the extractor never produced never reached the classifier. Counting it as a
 * classifier error would make the classifier responsible for a stage it never saw,
 * and — worse — would let a run improve its classifier score by suppressing
 * candidates. S47 states the same thing from the other side: "JEV no puede recuperar
 * candidatos que el extractor omitió". The two numbers therefore live on different
 * axes with different denominators, and this module has no function that adds them.
 */

import type { CandidateDecision } from "../classify/types.js";
import type { SupportVerdict } from "../jev/types.js";
import { NO_MATCH_LABEL, UNCERTAIN_LABEL } from "./types.js";
import type {
  ClassificationMetrics,
  ConfusionBreakdown,
  EvalReport,
  EvalSet,
  ExtractorCoverageMetrics,
  InformationLossMetrics,
  LabeledExample,
  ObservedDecision,
  RunInfo,
  SupportMetrics,
} from "./types.js";

/** Which state of the free vocabulary a decision carries. */
type FreeState = Extract<CandidateDecision["classificationState"], "free_no_match" | "free_uncertain">;

/** Everything one scoring pass needs. */
export interface ScoreInput {
  /** The labeled set: its order and its labels define the report. */
  readonly set: EvalSet;
  /** One observation per example, matched by id. */
  readonly observed: readonly ObservedDecision[];
  /** Which runner produced the observations. */
  readonly run: RunInfo;
  /** The catalog version the classifier was asked to resolve against. */
  readonly catalogVersion: string;
}

/** The running counters, mutable only inside this module. */
interface Tallies {
  candidates: number;
  evaluated: number;
  abstentions: number;
  confusion: Record<keyof ConfusionBreakdown, number>;
  judged: number;
  supportCorrect: number;
  falseSupport: number;
  missedSupport: number;
  undecided: number;
  unjudged: number;
  notEvaluated: number;
  pending: number;
  failed: number;
  freeWhenLabelExisted: number;
}

/**
 * Divides safely, so an empty axis reports 0 rather than NaN.
 *
 * @param numerator - The counted part.
 * @param denominator - The whole.
 * @returns The ratio, rounded to six decimals, or 0 when the denominator is 0.
 */
export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1e6) / 1e6;
}

/**
 * Whether a label names a canonical type rather than an abstention.
 *
 * @param canonical - The human label.
 * @returns True when the label expects a catalog type.
 */
function isCanonicalLabel(canonical: string): boolean {
  return canonical !== NO_MATCH_LABEL && canonical !== UNCERTAIN_LABEL;
}

/**
 * Classifies one decision against one human label.
 *
 * @param decision - The classifier's decision.
 * @param canonical - The human label.
 * @returns The confusion cell the pair falls into.
 */
function confusionCell(decision: CandidateDecision, canonical: string): keyof ConfusionBreakdown {
  if (decision.classificationState === "classified") {
    if (!isCanonicalLabel(canonical)) return "classifiedWhenNotDecidable";
    return decision.canonicalType === canonical ? "correctCanonicalType" : "wrongCanonicalType";
  }
  if (isCanonicalLabel(canonical)) return "abstainedWhenTypeExisted";
  const expected = canonical === NO_MATCH_LABEL ? "free_no_match" : "free_uncertain";
  return decision.classificationState === expected ? "correctAbstention" : "abstentionReasonMismatch";
}

/**
 * Whether a decision state is one of the two free states.
 *
 * @param state - The stored classification state.
 * @returns True for `free_no_match` and `free_uncertain`.
 */
function isFree(state: CandidateDecision["classificationState"]): state is FreeState {
  return state === "free_no_match" || state === "free_uncertain";
}

/**
 * Folds one decision into the classifier and information-loss tallies.
 *
 * @param tallies - The running counters.
 * @param example - The labeled example the decision belongs to.
 * @param decision - The classifier's decision.
 */
function tallyDecision(tallies: Tallies, example: LabeledExample, decision: CandidateDecision): void {
  tallies.candidates += 1;
  if (decision.classificationState === "pending" || decision.classificationState === "failed") {
    tallies.notEvaluated += 1;
    tallies[decision.classificationState] += 1;
    return;
  }
  tallies.evaluated += 1;
  if (isFree(decision.classificationState)) tallies.abstentions += 1;
  const cell = confusionCell(decision, example.labels.canonical);
  tallies.confusion[cell] += 1;
  if (cell === "abstainedWhenTypeExisted") tallies.freeWhenLabelExisted += 1;
}

/**
 * Folds one support verdict into the support tallies.
 *
 * @param tallies - The running counters.
 * @param example - The labeled example the verdict belongs to.
 * @param verdict - The support verdict, or `null` when none was produced.
 */
function tallySupport(tallies: Tallies, example: LabeledExample, verdict: SupportVerdict | null): void {
  if (verdict === null || verdict.status === "operational_failure") {
    tallies.unjudged += 1;
    return;
  }
  if (verdict.status === "uncertain") {
    tallies.undecided += 1;
    return;
  }
  tallies.judged += 1;
  if (verdict.status === example.labels.support) {
    tallies.supportCorrect += 1;
  } else if (verdict.status === "supported") {
    tallies.falseSupport += 1;
  } else {
    tallies.missedSupport += 1;
  }
}

/**
 * Builds the classifier axis from the tallies.
 *
 * @param tallies - The running counters.
 * @returns The classifier metrics.
 */
function classificationMetrics(tallies: Tallies): ClassificationMetrics {
  const correct = tallies.confusion.correctCanonicalType + tallies.confusion.correctAbstention;
  return {
    evaluated: tallies.evaluated,
    correct,
    accuracy: ratio(correct, tallies.evaluated),
    abstentions: tallies.abstentions,
    abstentionRate: ratio(tallies.abstentions, tallies.evaluated),
    confusion: { ...tallies.confusion },
  };
}

/**
 * Builds the support axis from the tallies.
 *
 * @param tallies - The running counters.
 * @returns The support metrics.
 */
function supportMetrics(tallies: Tallies): SupportMetrics {
  return {
    judged: tallies.judged,
    correct: tallies.supportCorrect,
    accuracy: ratio(tallies.supportCorrect, tallies.judged),
    falseSupport: tallies.falseSupport,
    missedSupport: tallies.missedSupport,
    undecided: tallies.undecided,
    unjudged: tallies.unjudged,
  };
}

/**
 * Builds the information-loss axis from the tallies.
 *
 * @param tallies - The running counters.
 * @returns The information-loss metrics.
 */
function informationLossMetrics(tallies: Tallies): InformationLossMetrics {
  const lost = tallies.notEvaluated + tallies.freeWhenLabelExisted;
  return {
    candidates: tallies.candidates,
    notEvaluated: tallies.notEvaluated,
    pending: tallies.pending,
    failed: tallies.failed,
    freeWhenLabelExisted: tallies.freeWhenLabelExisted,
    lossRate: ratio(lost, tallies.candidates),
  };
}

/**
 * Builds the extractor-coverage axis, over the whole labeled set.
 *
 * @param set - The labeled set.
 * @param omitted - Ids of the facts the extractor never produced.
 * @returns The coverage metrics.
 */
function coverageMetrics(set: EvalSet, omitted: readonly string[]): ExtractorCoverageMetrics {
  const labeledFacts = set.examples.length;
  const produced = labeledFacts - omitted.length;
  return { labeledFacts, produced, omitted: omitted.length, omittedIds: omitted, coverageRate: ratio(produced, labeledFacts) };
}

/**
 * Creates the zeroed counters of one scoring pass.
 *
 * @returns Fresh counters, so two reports can never share state.
 */
function emptyTallies(): Tallies {
  return {
    candidates: 0,
    evaluated: 0,
    abstentions: 0,
    confusion: {
      correctCanonicalType: 0,
      correctAbstention: 0,
      wrongCanonicalType: 0,
      abstainedWhenTypeExisted: 0,
      classifiedWhenNotDecidable: 0,
      abstentionReasonMismatch: 0,
    },
    judged: 0,
    supportCorrect: 0,
    falseSupport: 0,
    missedSupport: 0,
    undecided: 0,
    unjudged: 0,
    notEvaluated: 0,
    pending: 0,
    failed: 0,
    freeWhenLabelExisted: 0,
  };
}

/**
 * Scores one run against one labeled set.
 *
 * @param input - The set, the observations, the run and the catalog version.
 * @returns The four-axis report.
 * @throws {Error} When an extracted example has no observation, which is a runner bug.
 */
export function scoreEvalSet(input: ScoreInput): EvalReport {
  const observedById = new Map(input.observed.map((entry) => [entry.exampleId, entry] as const));
  const tallies = emptyTallies();
  const omitted: string[] = [];
  for (const example of input.set.examples) {
    if (!example.extracted) {
      omitted.push(example.id);
      continue;
    }
    const observed = observedById.get(example.id);
    if (observed === undefined || observed.decision === null) {
      throw new Error(`no decision was observed for extracted example ${example.id}`);
    }
    tallyDecision(tallies, example, observed.decision);
    tallySupport(tallies, example, observed.support);
  }
  return {
    setVersion: input.set.version,
    catalogVersion: input.catalogVersion,
    run: input.run,
    classification: classificationMetrics(tallies),
    support: supportMetrics(tallies),
    informationLoss: informationLossMetrics(tallies),
    extractorCoverage: coverageMetrics(input.set, omitted),
  };
}
