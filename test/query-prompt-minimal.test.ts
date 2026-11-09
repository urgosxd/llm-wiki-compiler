/**
 * Unit tests for the trimmed `query` system prompts.
 *
 * The `query` pipeline makes two model calls, and both used to spend their
 * system prompt on prose that carried nothing: the page-selection prompt
 * announced "You are a knowledge base assistant" and then restated both the
 * `select_pages` tool description and the shape of the user message handed to
 * it, while the answer prompt announced "You are a knowledge assistant" before
 * getting to its three real rules. Those identity lines were removed; the
 * behavioral rules stayed byte-identical.
 *
 * These assertions run the real prompt-building path — `selectPages` and
 * `generateAnswer` — and inspect the `system` string each request actually
 * handed to the LLM boundary, so they pin what the model receives rather than
 * the source text that produces it. The answer prompt must still carry all
 * three rules — grounding (`ONLY the wiki content provided`), the citation
 * format (`[[Page Title]]`), and the insufficient-information admission —
 * because dropping any of them would change answers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAlphaPageFixture } from "./fixtures/alpha-page.js";
import { generateAnswer } from "../packages/wiki/src/commands/query.js";
import { selectPages } from "../packages/wiki/src/commands/page-selection.js";

const QUESTION = "What is alpha?";
const SELECTED_PAGE_ID = "concepts/alpha";
const ALPHA_INDEX = `- ${SELECTED_PAGE_ID}: Alpha summary`;

/**
 * System prompts the stubbed LLM boundary received, split by call kind: a
 * request carrying `tools` is the page-selection call, one without is the
 * answer call.
 */
const prompts = vi.hoisted(() => ({ selection: [] as string[], answer: [] as string[] }));

vi.mock("../packages/wiki/src/utils/llm.js", () => ({
  callClaude: vi.fn(async (options: { system: string; tools?: unknown[] }) => {
    if (options.tools) {
      prompts.selection.push(options.system);
      return JSON.stringify({ pages: [SELECTED_PAGE_ID], reasoning: "stubbed selection" });
    }
    prompts.answer.push(options.system);
    return "Stubbed answer body.";
  }),
}));

const alphaRoot = useAlphaPageFixture("query-prompt-minimal");

beforeEach(() => {
  prompts.selection.length = 0;
  prompts.answer.length = 0;
});

/** Generate one answer over the alpha fixture and return the system prompt sent. */
async function answerSystemPrompt(): Promise<string> {
  const root = await alphaRoot();
  await generateAnswer(root, QUESTION, { save: false });
  const prompt = prompts.answer.at(-1);
  expect(prompt, "the answer call should have carried a system prompt").toBeDefined();
  return prompt ?? "";
}

describe("query answer system prompt", () => {
  it("carries no identity line the user message does not need", async () => {
    const prompt = await answerSystemPrompt();
    expect(prompt).not.toContain("knowledge assistant");
    expect(prompt).not.toContain("You are a knowledge");
  });

  it("keeps the grounding, citation, and abstention rules", async () => {
    const prompt = await answerSystemPrompt();
    expect(prompt).toContain("Answer the question using ONLY the wiki content provided.");
    expect(prompt).toContain("Cite specific pages using [[Page Title]] wikilinks.");
    expect(prompt).toContain("If the wiki doesn't contain enough information, say so.");
  });
});

describe("query page-selection system prompt", () => {
  it("does not restate the tool description or the user message layout", async () => {
    await selectPages(QUESTION, ALPHA_INDEX);
    const prompt = prompts.selection.at(-1);
    expect(prompt, "the selection call should have carried a system prompt").toBeDefined();
    expect(prompt).not.toContain("knowledge base assistant");
    expect(prompt).not.toContain("select the most relevant pages");
  });
});

describe("query page-selection system prompt exact value", () => {
  it("sends an empty system string for the selection call", async () => {
    await selectPages(QUESTION, ALPHA_INDEX);
    expect(prompts.selection.at(-1)).toBe("");
  });
});
