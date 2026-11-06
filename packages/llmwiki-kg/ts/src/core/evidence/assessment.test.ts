/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/assessment.test.ts
 * @description Keeping "the quote exists" apart from "the quote supports the claim".
 *
 * WHY THIS FILE EXISTS. S12 of the feature is a negative requirement: a quote
 * that exists never guarantees that it supports the extractor's reading. The only
 * way to honour it is to make the two facts structurally different, so a caller
 * cannot read one as the other. These tests pin that difference: a located quote
 * with an `unsupported` verdict must be representable, and a support verdict must
 * be impossible to attach to a quote that was never found.
 */

import { describe, expect, it } from "vitest";

import {
  assessQuote,
  evidenceKindOf,
  hasTextualEvidence,
  supportVerdict,
  withSupport,
} from "./assessment.js";
import { locateQuote } from "./locate.js";
import { EvidenceStageError, NOT_FOUND_LOCATION } from "./types.js";

/** A chunk whose sentence does NOT support an approval claim. */
const CHUNK = "The reviewer signs the policy.";

/** The verdict a classifier double would return for the claim above. */
const NON_SUPPORTING = {
  verdict: "unsupported" as const,
  assessedBy: "jev-double",
  rationale: "The sentence describes a signature, not an approval.",
};

describe("evidence assessment", () => {
  it("represents a present quote that does not support the claim", () => {
    const assessment = withSupport(assessQuote(locateQuote(CHUNK, CHUNK)), NON_SUPPORTING);
    expect(assessment.quote.status).toBe("found");
    expect(hasTextualEvidence(assessment)).toBe(true);
    expect(supportVerdict(assessment)).toBe("unsupported");
    expect(evidenceKindOf(assessment)).toBe("semantic");
  });

  it("reports an unjudged quote as textual evidence only", () => {
    const assessment = assessQuote(locateQuote(CHUNK, CHUNK));
    expect(hasTextualEvidence(assessment)).toBe(true);
    expect(supportVerdict(assessment)).toBeNull();
    expect(evidenceKindOf(assessment)).toBe("textual");
  });

  it("refuses a support verdict for a quote that was not located", () => {
    const absent = assessQuote(NOT_FOUND_LOCATION);
    expect(hasTextualEvidence(absent)).toBe(false);
    expect(() => withSupport(absent, NON_SUPPORTING)).toThrow(EvidenceStageError);
    expect(() => withSupport(absent, NON_SUPPORTING)).toThrow(/not located/);
  });
});
