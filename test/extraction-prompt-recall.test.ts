/**
 * Unit tests for the extraction prompt's concept-recall contract.
 *
 * The prompt used to ask for a brief 3-8 concept selection, which silently
 * capped what a long or dense source could contribute: concepts the model was
 * never asked for cannot be recovered by any later stage. The prompt now asks
 * for exhaustive recall up to {@link MAX_CONCEPTS_PER_SOURCE}, while still
 * telling the model not to pad the list with near-duplicate variants.
 *
 * These assertions pin the three parts of that contract — the ceiling, the
 * exhaustiveness ask, and the anti-padding guard — because nothing downstream
 * enforces the ceiling: `parseConcepts` accepts every concept the model
 * returns and no stage truncates the array.
 */

import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../src/compiler/prompts.js";
import { MAX_CONCEPTS_PER_SOURCE } from "../src/utils/constants.js";

/** The extraction prompt with no dedup index, for wording assertions. */
function prompt(): string {
  return buildExtractionPrompt("source body", "");
}

describe("buildExtractionPrompt concept recall", () => {
  it("names the concept ceiling from the shared constant", () => {
    expect(prompt()).toContain(`maximum of ${MAX_CONCEPTS_PER_SOURCE} concepts`);
  });

  it("asks for every substantiated concept rather than a small selection", () => {
    expect(prompt()).toContain("identify every distinct, meaningful concept");
  });

  it("no longer asks for the old 3-8 selection", () => {
    expect(prompt()).not.toContain("3-8");
  });

  it("forbids padding the list with near-duplicate variants", () => {
    expect(prompt()).toContain("Do not pad the list");
    expect(prompt()).toContain("near-duplicate");
  });

  it("keeps the ceiling instruction before the source document", () => {
    expect(prompt().indexOf("maximum of")).toBeLessThan(
      prompt().indexOf("--- SOURCE DOCUMENT ---"),
    );
  });
});
