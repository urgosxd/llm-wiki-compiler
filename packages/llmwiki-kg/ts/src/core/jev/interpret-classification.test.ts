/**
 * @file packages/llmwiki-kg/ts/src/core/jev/interpret-classification.test.ts
 * @description Turning one vendor answer into one classification verdict.
 *
 * WHY THIS FILE EXISTS. The four verdicts are not four labels on one scale:
 * `classified` is a positive decision, `free_no_match` and `free_uncertain` are
 * different abstentions, and `operational_failure` says the provider never gave
 * us a usable answer at all. Every test here also asserts what the verdict is
 * NOT, because the failure this stage has to prevent (S25) is a provider problem
 * being read as a catalog judgement.
 */

import { describe, expect, it } from "vitest";

import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { DEFAULT_JEV_THRESHOLDS } from "./config.js";
import {
  CLASSIFICATION_REASON_NO_MATCH,
  CLASSIFICATION_REASON_UNCERTAIN_FIT,
  CLASSIFICATION_REASON_UNCERTAIN_TOP,
  interpretClassification,
} from "./interpret.js";
import { ENTITY_CLASSIFICATION_QUESTIONS } from "./questions.js";
import type { ClassificationVerdict, JevDecisionOutcome, JevDecisionResponse } from "./types.js";

interface Answer {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly fits: number;
}

function answerOutcome(input: Answer): JevDecisionOutcome {
  const response: JevDecisionResponse = {
    model: "jev-test",
    answers: {
      [ENTITY_CLASSIFICATION_QUESTIONS.choice]: {
        type: "choice",
        choice: input.choice,
        probabilities: input.probabilities,
        confidence: input.confidence,
      },
      [ENTITY_CLASSIFICATION_QUESTIONS.fits]: { type: "noul", noul: input.fits },
    },
  };
  return { status: "answered", response };
}

function classify(outcome: JevDecisionOutcome): ClassificationVerdict {
  return interpretClassification(outcome, {
    catalog: defaultTypeCatalog(),
    thresholds: DEFAULT_JEV_THRESHOLDS,
    questions: ENTITY_CLASSIFICATION_QUESTIONS,
  });
}

const PROVIDER_FAILED: JevDecisionOutcome = {
  status: "provider_failure",
  kind: "provider_failed",
  state: "pending",
  reason: "provider unavailable after 3 attempts",
};

describe("interpretClassification — a catalog type fits", () => {
  it("classifies with the raw choice, every probability and the vendor confidence preserved", () => {
    const probabilities = { Role: 0.72, Process: 0.18, Document: 0.1 };
    const verdict = classify(answerOutcome({ choice: "Role", probabilities, confidence: 0.81, fits: 0.9 }));
    expect(verdict.status).toBe("classified");
    expect(verdict.status === "classified" ? verdict.canonicalType : undefined).toBe("Role");
    expect(verdict.status === "classified" ? verdict.readout.probabilities : undefined).toEqual(probabilities);
    expect(verdict.status === "classified" ? verdict.readout.confidence : undefined).toBe(0.81);
    expect(verdict.status === "classified" ? verdict.readout.topProbability : undefined).toBe(0.72);
  });

  it("keeps the vendor confidence as a dispersion measure and never uses it as a correctness gate", () => {
    const verdict = classify(
      answerOutcome({ choice: "Process", probabilities: { Process: 0.9, Role: 0.1 }, confidence: 0.04, fits: 0.95 }),
    );
    expect(verdict.status).toBe("classified");
    expect(verdict.status === "classified" ? verdict.readout.confidence : undefined).toBe(0.04);
  });
});

describe("interpretClassification — abstentions", () => {
  it("reports free_no_match when the companion noul says no catalog option fits", () => {
    const verdict = classify(
      answerOutcome({ choice: "Document", probabilities: { Document: 0.55, Policy: 0.45 }, confidence: 0.3, fits: 0.05 }),
    );
    expect(verdict.status).toBe("free_no_match");
    expect("canonicalType" in verdict).toBe(false);
    expect(verdict.status === "free_no_match" ? verdict.reason : undefined).toBe(CLASSIFICATION_REASON_NO_MATCH);
    expect(verdict.status === "free_no_match" ? verdict.readout.choice : undefined).toBe("Document");
  });

  it("reports free_uncertain when the catalog fit sits inside the uncertain band", () => {
    const verdict = classify(
      answerOutcome({ choice: "Policy", probabilities: { Policy: 0.8, Process: 0.2 }, confidence: 0.6, fits: 0.5 }),
    );
    expect(verdict.status).toBe("free_uncertain");
    expect(verdict.status === "free_uncertain" ? verdict.reason : undefined).toBe(CLASSIFICATION_REASON_UNCERTAIN_FIT);
    expect("canonicalType" in verdict).toBe(false);
  });

  it("reports free_uncertain when no catalog type dominates the distribution", () => {
    const verdict = classify(
      answerOutcome({ choice: "Role", probabilities: { Role: 0.4, Process: 0.35, System: 0.25 }, confidence: 0.2, fits: 0.9 }),
    );
    expect(verdict.status).toBe("free_uncertain");
    expect(verdict.status === "free_uncertain" ? verdict.reason : undefined).toBe(CLASSIFICATION_REASON_UNCERTAIN_TOP);
  });
});

describe("interpretClassification — unusable answers can never become a catalog judgement", () => {
  it("turns a provider failure into an operational failure, never free_no_match", () => {
    const verdict = classify(PROVIDER_FAILED);
    expect(verdict.status).toBe("operational_failure");
    expect(verdict.status === "operational_failure" ? verdict.state : undefined).toBe("pending");
    expect(verdict.status === "operational_failure" ? verdict.kind : undefined).toBe("provider_failed");
    expect("canonicalType" in verdict).toBe(false);
  });

  it("treats an answered payload that lacks the companion noul as invalid, not as no match", () => {
    const verdict = classify({
      status: "answered",
      response: {
        model: "jev-test",
        answers: {
          [ENTITY_CLASSIFICATION_QUESTIONS.choice]: {
            type: "choice",
            choice: "Role",
            probabilities: { Role: 0.9 },
            confidence: 0.7,
          },
        },
      },
    });
    expect(verdict.status).toBe("operational_failure");
    expect(verdict.status === "operational_failure" ? verdict.kind : undefined).toBe("invalid_response");
    expect(verdict.status === "operational_failure" ? verdict.state : undefined).toBe("failed");
  });

  it("refuses a chosen label the catalog does not declare instead of assuming a type", () => {
    const verdict = classify(
      answerOutcome({ choice: "Invoice", probabilities: { Invoice: 0.9 }, confidence: 0.7, fits: 0.9 }),
    );
    expect(verdict.status).toBe("operational_failure");
    expect(verdict.status === "operational_failure" ? verdict.kind : undefined).toBe("invalid_response");
  });
});
