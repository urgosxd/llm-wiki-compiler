/**
 * @file packages/llmwiki-kg/ts/src/core/jev/interpret-support.test.ts
 * @description The semantic-support decision, kept independent of classification.
 *
 * WHY THIS FILE EXISTS. S12 says a quote that EXISTS does not thereby SUPPORT the
 * claim. The case that matters most is the middle one: evidence was located, it is
 * real source text, and it simply does not say what the extractor read into it.
 * That must come back as `unsupported` — a definite negative about meaning, not an
 * error and not an abstention — while a broken provider must never be mistaken for
 * either.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_JEV_THRESHOLDS } from "./config.js";
import { SUPPORT_REASON_UNCERTAIN, interpretSupport } from "./interpret.js";
import { SUPPORT_CHOICE_LABELS, SUPPORT_QUESTION_ID } from "./questions.js";
import type { JevDecisionOutcome, SupportVerdict } from "./types.js";

function supportOutcome(label: string, probabilities: Readonly<Record<string, number>>): JevDecisionOutcome {
  return {
    status: "answered",
    response: {
      model: "jev-test",
      answers: {
        [SUPPORT_QUESTION_ID]: { type: "choice", choice: label, probabilities, confidence: 0.44 },
      },
    },
  };
}

function judge(outcome: JevDecisionOutcome): SupportVerdict {
  return interpretSupport(outcome, DEFAULT_JEV_THRESHOLDS);
}

describe("interpretSupport", () => {
  it("reports UNSUPPORTED for a quote that exists but does not support the claim", () => {
    const verdict = judge(
      supportOutcome(SUPPORT_CHOICE_LABELS.unsupported, { SUPPORTED: 0.08, UNSUPPORTED: 0.92 }),
    );
    expect(verdict.status).toBe("unsupported");
    expect(verdict.status === "unsupported" ? verdict.readout.confidence : undefined).toBe(0.44);
  });

  it("reports SUPPORTED when the quote states the claim", () => {
    const verdict = judge(supportOutcome(SUPPORT_CHOICE_LABELS.supported, { SUPPORTED: 0.93, UNSUPPORTED: 0.07 }));
    expect(verdict.status).toBe("supported");
    expect(verdict.status === "supported" ? verdict.readout.topProbability : undefined).toBe(0.93);
  });

  it("reports UNCERTAIN when the top probability sits inside the configured band", () => {
    const verdict = judge(supportOutcome(SUPPORT_CHOICE_LABELS.supported, { SUPPORTED: 0.55, UNSUPPORTED: 0.45 }));
    expect(verdict.status).toBe("uncertain");
    expect(verdict.status === "uncertain" ? verdict.reason : undefined).toBe(SUPPORT_REASON_UNCERTAIN);
  });

  it("reports an operational failure for a provider problem, never a support verdict", () => {
    const verdict = judge({ status: "provider_failure", kind: "provider_answered", state: "failed", reason: "401" });
    expect(verdict.status).toBe("operational_failure");
    expect(verdict.status === "operational_failure" ? verdict.state : undefined).toBe("failed");
    expect(verdict.status === "operational_failure" ? verdict.kind : undefined).toBe("provider_answered");
  });

  it("refuses a label outside the SUPPORTED/UNSUPPORTED pair instead of guessing one", () => {
    const verdict = judge(supportOutcome("PARTIAL", { PARTIAL: 0.9 }));
    expect(verdict.status).toBe("operational_failure");
    expect(verdict.status === "operational_failure" ? verdict.kind : undefined).toBe("invalid_response");
  });
});
