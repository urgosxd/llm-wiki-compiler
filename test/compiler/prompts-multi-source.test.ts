/**
 * @file test/compiler/prompts-multi-source.test.ts
 * @description The page prompt asks for PER-SOURCE ATTRIBUTION of a merged article (S2, S7).
 *
 * The citation machinery downstream can only normalize or report the markers a model
 * wrote; it cannot ask the model to attribute a merged claim to the source it came from.
 * So the prompt has to carry the rule: many sources become ONE article, and every
 * contributing source is cited somewhere in it. The `^[file.md:lines]` convention the
 * prompt names is the same one `citation-normalize.ts` and the citation lint already
 * speak, so the requirement is expressible in a form the rest of the pipeline can read.
 *
 * A wording change to the page prompt bumps `PROMPT_VERSION`, because the stamp is how a
 * reader tells two prompt generations apart.
 */

import { describe, it, expect } from "vitest";
import { buildPagePrompt, PROMPT_VERSION } from "../../src/compiler/prompts.js";

/** The page prompt a project with no output-language override sees. */
function pagePrompt(): string {
  return buildPagePrompt("Vector DB", "1 | Source text.", "", "");
}

describe("buildPagePrompt — multi-source attribution", () => {
  it("requires ONE article that merges its sources rather than one section per source", () => {
    const prompt = pagePrompt();
    expect(prompt).toContain(
      "When more than one source contributes to this page, merge what they say into ONE article.",
    );
    expect(prompt).toContain("Do not write one section per source");
    expect(prompt).toContain("do not join their texts without attribution");
  });

  it("requires every contributing source to be attributed somewhere in the page", () => {
    const prompt = pagePrompt();
    expect(prompt).toContain("Attribute every contributing source");
    expect(prompt).toContain(
      "a claim taken from one source never appears without naming that source",
    );
  });

  it("keeps the merged-article rule inside the shared prefix every page receives", () => {
    const prompt = pagePrompt();
    const endMarker = prompt.indexOf("--- END SOURCE MATERIAL ---");
    expect(endMarker).toBeGreaterThan(0);
    expect(prompt.indexOf("Attribute every contributing source")).toBeLessThan(endMarker);
  });

  it("keeps the per-paragraph citation convention the pipeline normalizes", () => {
    const prompt = pagePrompt();
    expect(prompt).toContain("PREFERRED format: ^[filename.md:START-END]");
    expect(prompt).toContain("For multi-source paragraphs: ^[a.md:1-5, b.md:10-12].");
  });

  it("stamps a prompt generation that includes the merged-article rule", () => {
    // v9 adds the per-source attribution rule above; the pin moves with the stamp.
    expect(PROMPT_VERSION).toBe("v9");
  });
});
