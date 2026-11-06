/**
 * @file packages/llmwiki-kg/ts/src/core/eval/scorer.test.ts
 * @description The scorer's arithmetic, on a synthetic set small enough to check by hand.
 *
 * Two failures matter more than any other here: a classification error must land on
 * the classifier axis and NOT on the extractor axis, and a fact the extractor never
 * produced must land on the extractor axis and NOT be counted as a classifier error.
 * JEV cannot recover a candidate the extractor omitted, so mixing those two numbers
 * would make the classifier look responsible for a stage it never saw. Both
 * misplacements are asserted directly.
 */

import { describe, expect, it } from "vitest";
import type { CandidateDecision } from "../classify/types.js";
import type { SupportVerdict } from "../jev/types.js";
import { scoreEvalSet } from "./scorer.js";
import type { LabeledExample, ObservedDecision, RunInfo } from "./types.js";

const RUN: RunInfo = { mode: "offline", model: "jev-test", baseUrl: null };

/** One synthetic example's inputs. */
interface ExampleSpec {
  readonly id: string;
  readonly canonical: string;
  readonly support?: "supported" | "unsupported";
  readonly extracted?: boolean;
}

/**
 * Builds one synthetic labeled example.
 *
 * @param spec - Id, canonical label, support label and whether the extractor produced it.
 * @returns The example.
 */
function example(spec: ExampleSpec): LabeledExample {
  const base = {
    id: spec.id,
    language: "en" as const,
    kind: "entity" as const,
    source: "source text",
    quote: "source",
    claim: "the claim",
    labels: { canonical: spec.canonical, support: spec.support ?? ("supported" as const) },
  };
  return spec.extracted === false
    ? { ...base, extracted: false, fact: { name: spec.id } }
    : { ...base, extracted: true, candidate: { name: spec.id, proposedType: "ROLE" } };
}

/**
 * Builds one entity decision in the state a classifier run produced.
 *
 * @param id - The example (and candidate ref) it belongs to.
 * @param classificationState - The stored classification state.
 * @param canonicalType - The canonical type, for a positive classification.
 * @returns The decision.
 */
function decision(
  id: string,
  classificationState: CandidateDecision["classificationState"],
  canonicalType: string | null = null,
): CandidateDecision {
  return {
    kind: "entity",
    ref: id,
    name: id,
    classificationState,
    canonicalType,
    supportState: null,
    reason: null,
    readout: null,
    catalogVersion: "1.0.0",
  };
}

/**
 * Builds one support verdict, decided or not.
 *
 * @param status - `supported`, `unsupported` or `uncertain`.
 * @returns The verdict.
 */
function support(status: "supported" | "unsupported" | "uncertain"): SupportVerdict {
  const readout = { choice: status, probabilities: { [status]: 0.9 }, confidence: 0.5, topProbability: 0.9, model: "m" };
  return status === "uncertain" ? { status: "uncertain", reason: "band", readout } : { status, readout };
}

/**
 * Assembles one observation per example, in example order.
 *
 * @param examples - The labeled examples.
 * @param rows - The decision/verdict pair per example, positionally.
 * @returns The observations the scorer consumes.
 */
function observe(
  examples: readonly LabeledExample[],
  rows: readonly (readonly [CandidateDecision | null, SupportVerdict | null])[],
): ObservedDecision[] {
  return examples.map((item, index) => {
    const row = rows[index];
    if (row === undefined) throw new Error(`no observation row for ${item.id}`);
    return { exampleId: item.id, decision: row[0], support: row[1] };
  });
}

/**
 * Scores a synthetic set of entity examples.
 *
 * @param examples - The labeled examples.
 * @param rows - The decision/verdict pair per example, positionally.
 * @returns The scored report.
 */
function score(examples: readonly LabeledExample[], rows: readonly (readonly [CandidateDecision | null, SupportVerdict | null])[]) {
  return scoreEvalSet({ set: { version: "v@1.0.0", examples }, observed: observe(examples, rows), run: RUN, catalogVersion: "1.0.0" });
}

describe("scoreEvalSet", () => {
  it("puts a wrong classification on the classifier axis and a miss on the extractor axis", () => {
    const report = score(
      [example({ id: "right", canonical: "Role" }), example({ id: "wrong", canonical: "Process" }), example({ id: "missed", canonical: "Process", extracted: false })],
      [
        [decision("right", "classified", "Role"), support("supported")],
        [decision("wrong", "classified", "Document"), support("supported")],
        [null, null],
      ],
    );
    expect(report.classification.evaluated).toBe(2);
    expect(report.classification.accuracy).toBe(0.5);
    expect(report.classification.confusion.correctCanonicalType).toBe(1);
    expect(report.classification.confusion.wrongCanonicalType).toBe(1);
    expect(report.extractorCoverage.omitted).toBe(1);
    expect(report.extractorCoverage.omittedIds).toEqual(["missed"]);
    expect(report.extractorCoverage.coverageRate).toBe(0.666667);
    expect(report.informationLoss.notEvaluated).toBe(0);
  });

  it("separates the three abstention mistakes from a correct abstention", () => {
    const report = score(
      [
        example({ id: "stayed-free", canonical: "Process" }),
        example({ id: "over-typed", canonical: "NO_MATCH" }),
        example({ id: "uncertain", canonical: "UNCERTAIN" }),
        example({ id: "free-ok", canonical: "NO_MATCH" }),
      ],
      [
        [decision("stayed-free", "free_uncertain"), null],
        [decision("over-typed", "classified", "supports"), null],
        [decision("uncertain", "free_uncertain"), null],
        [decision("free-ok", "free_no_match"), null],
      ],
    );
    expect(report.classification.confusion.abstainedWhenTypeExisted).toBe(1);
    expect(report.classification.confusion.classifiedWhenNotDecidable).toBe(1);
    expect(report.classification.confusion.correctAbstention).toBe(2);
    expect(report.classification.confusion.abstentionReasonMismatch).toBe(0);
    expect(report.classification.abstentions).toBe(3);
    expect(report.classification.abstentionRate).toBe(0.75);
    expect(report.informationLoss.freeWhenLabelExisted).toBe(1);
  });

  it("treats an operational state as information loss, never as a classification error", () => {
    const report = score(
      [example({ id: "pending", canonical: "Role" }), example({ id: "failed", canonical: "Role" })],
      [
        [decision("pending", "pending"), null],
        [decision("failed", "failed"), null],
      ],
    );
    expect(report.informationLoss.notEvaluated).toBe(2);
    expect(report.informationLoss.pending).toBe(1);
    expect(report.informationLoss.failed).toBe(1);
    expect(report.classification.evaluated).toBe(0);
    expect(report.classification.confusion.wrongCanonicalType).toBe(0);
  });

  it("counts a supporting quote judged unsupported, and the reverse, separately", () => {
    const report = score(
      [
        example({ id: "false-support", canonical: "Role", support: "unsupported" }),
        example({ id: "missed-support", canonical: "Role", support: "supported" }),
        example({ id: "undecided", canonical: "Role", support: "supported" }),
      ],
      [
        [decision("false-support", "classified", "Role"), support("supported")],
        [decision("missed-support", "classified", "Role"), support("unsupported")],
        [decision("undecided", "classified", "Role"), support("uncertain")],
      ],
    );
    expect(report.support.judged).toBe(2);
    expect(report.support.correct).toBe(0);
    expect(report.support.accuracy).toBe(0);
    expect(report.support.falseSupport).toBe(1);
    expect(report.support.missedSupport).toBe(1);
    expect(report.support.undecided).toBe(1);
    expect(report.support.unjudged).toBe(0);
  });

  it("reports the four axes and never a blended score", () => {
    const report = score(
      [example({ id: "only", canonical: "Role" })],
      [[decision("only", "classified", "Role"), support("supported")]],
    );
    expect(Object.keys(report).sort()).toEqual(
      ["catalogVersion", "classification", "extractorCoverage", "informationLoss", "run", "setVersion", "support"].sort(),
    );
  });
});
