/**
 * @file test/compiler/prompts-anchored-links.test.ts
 * @description The page prompt asks for ANCHORED contextual links (S8).
 *
 * The validator downstream can only refuse links; it cannot ask the model for
 * better ones. So the prompt has to carry the same rule the validator enforces:
 * link a concept only where the text already names it, only where the link helps
 * the reader, never to raise connectivity, never to itself, and at most once per
 * target per section. A wording change to the page prompt also bumps
 * `PROMPT_VERSION`, because the exported provenance is how a reader tells two
 * prompt generations apart.
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildPagePrompt, PROMPT_VERSION } from "../../src/compiler/prompts.js";

const ENV_KEY = "LLMWIKI_OUTPUT_LANG";

afterEach(() => {
  delete process.env[ENV_KEY];
});

/** The page prompt as a default project sees it. */
function pagePrompt(): string {
  return buildPagePrompt("Graph Theory", "1\tSource text.", "", "");
}

describe("buildPagePrompt — anchored links", () => {
  it("replaces the vague link suggestion with the anchoring rule", () => {
    const prompt = pagePrompt();
    expect(prompt).not.toContain("Suggest [[wikilinks]] to related concepts where appropriate.");
    expect(prompt).toContain("Link a concept only where the page text already names it.");
    expect(prompt).toContain("Write each link as [[target|the words that name it]]");
  });

  it("forbids links that exist for connectivity, for the page itself, or twice in a section", () => {
    const prompt = pagePrompt();
    expect(prompt).toContain("Add a link only when it helps the reader understand the passage.");
    expect(prompt).toContain("Never add a link to increase connectivity or to match a related list.");
    expect(prompt).toContain("Never link the page to itself.");
    expect(prompt).toContain("Link a target at most once per section.");
  });

  it("keeps the link rule inside the shared instruction prefix every page receives", () => {
    const prompt = pagePrompt();
    const endMarker = prompt.indexOf("--- END SOURCE MATERIAL ---");
    expect(endMarker).toBeGreaterThan(0);
    expect(prompt.indexOf("Never link the page to itself.")).toBeLessThan(endMarker);
  });

  it("bumps PROMPT_VERSION for the new page-prompt wording", () => {
    // v7 introduced the anchoring rule above; v8 added the reference-review prompt,
    // whose answers are part of what a run judged. The stamp tracks the CURRENT
    // generation, so this pin moves with it.
    expect(PROMPT_VERSION).toBe("v8");
  });
});
