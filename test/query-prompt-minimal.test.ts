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
 * format (the page id shown in each grounding header), and the
 * insufficient-information admission — because dropping any of them would
 * change answers.
 */

import "./fixtures/file-mode.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { useAlphaPageFixture } from "./fixtures/alpha-page.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { generateAnswer } from "../packages/wiki/src/commands/query.js";
import { selectPages } from "../packages/wiki/src/commands/page-selection.js";
import { reportAnswerCitations } from "../packages/wiki/src/citations/answer-report.js";

const QUESTION = "What is alpha?";
const SELECTED_PAGE_ID = "concepts/alpha";
const ALPHA_INDEX = `- ${SELECTED_PAGE_ID}: Alpha summary`;

/**
 * Prompts and user messages the stubbed LLM boundary received, split by call
 * kind: a request carrying `tools` is the page-selection call, one without is
 * the answer call. `selectionIds` is what the stubbed selector proposes.
 */
const prompts = vi.hoisted(() => ({
  selection: [] as string[],
  answer: [] as string[],
  users: [] as string[],
  selectionIds: ["concepts/alpha"] as string[],
}));

vi.mock("../packages/wiki/src/utils/llm.js", () => ({
  callClaude: vi.fn(async (options: { system: string; tools?: unknown[]; messages?: { content: string }[] }) => {
    if (options.tools) {
      prompts.selection.push(options.system);
      return JSON.stringify({ pages: prompts.selectionIds, reasoning: "stubbed selection" });
    }
    prompts.answer.push(options.system);
    prompts.users.push(options.messages?.[0]?.content ?? "");
    return "Stubbed answer body.";
  }),
}));

const alphaRoot = useAlphaPageFixture("query-prompt-minimal");

beforeEach(() => {
  prompts.selection.length = 0;
  prompts.answer.length = 0;
  prompts.users.length = 0;
  prompts.selectionIds.splice(0, prompts.selectionIds.length, SELECTED_PAGE_ID);
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
    expect(prompt).toContain("--- Page: <page id> ---");
    expect(prompt).toContain("[[concepts/example-page]]");
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

/**
 * Pages whose frontmatter `title` is NOT a resolvable identity: the resolver
 * matches a page's slug, its slug form, and its declared aliases — never its
 * title. Citing a title therefore produces a dead citation, which is exactly
 * what an instruction to cite `[[Page Title]]` asked the model to do.
 */
const TITLE_SHAPED_PAGES = [
  { directory: "concepts", stem: "7-subdominios-ddd", title: "Subdominios DDD" },
  { directory: "concepts", stem: "Raw Name", title: "Raw Name and Notes" },
  { directory: "queries", stem: "rbac-por-oficina", title: "RBAC por oficina" },
] as const;

const stagedRoots: string[] = [];

afterEach(async () => {
  await Promise.all(stagedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Write the title-shaped stack to a fresh temp root and return it. */
async function writeTitleShapedStack(): Promise<string> {
  const root = await makeTempRoot("query-prompt-grammar");
  stagedRoots.push(root);
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  for (const page of TITLE_SHAPED_PAGES) {
    await writePage(
      path.join(root, "wiki", page.directory),
      page.stem,
      { title: page.title, summary: `Summary of ${page.stem}` },
      `Body of ${page.stem}.`,
    );
  }
  return root;
}

/** The `--- Page: <id> ---` grounding headers the answer prompt actually carried. */
function groundingHeaderIds(userMessage: string): string[] {
  return [...userMessage.matchAll(/^--- Page: (.+?) ---$/gm)].map((match) => match[1]);
}

describe("the answer prompt names the citation grammar its headers show", () => {
  it("shows qualified page ids and tells the model to cite exactly those", async () => {
    const root = await writeTitleShapedStack();
    prompts.selectionIds.splice(0, prompts.selectionIds.length,
      ...TITLE_SHAPED_PAGES.map((page) => `${page.directory}/${page.stem}`));
    await generateAnswer(root, QUESTION, { save: false });

    const prompt = prompts.answer.at(-1) ?? "";
    const headerIds = groundingHeaderIds(prompts.users.at(-1) ?? "");
    expect(headerIds).toEqual(TITLE_SHAPED_PAGES.map((page) => `${page.directory}/${page.stem}`));

    // Every identity the prompt shows the model is citable as shown.
    for (const id of headerIds) {
      const report = await reportAnswerCitations(root, `Grounded in [[${id}]].`);
      expect(report.citations).toMatchObject([{ status: "resolved", pageId: id }]);
    }

    // And the instruction names that form instead of asking for a title.
    expect(prompt).toContain("--- Page: <page id> ---");
    expect(prompt).toContain("[[concepts/example-page]]");
    expect(prompt).not.toContain("[[Page Title]]");
  });

  it("still resolves a citation written as a bare slug, and still rejects a title", async () => {
    const root = await writeTitleShapedStack();

    // PRESERVE: the model may ignore the instruction and emit a bare slug; the
    // resolver supports it, including the slug form of a title-shaped stem.
    expect((await reportAnswerCitations(root, "Grounded in [[7-subdominios-ddd]].")).citations)
      .toMatchObject([{ status: "resolved", pageId: "concepts/7-subdominios-ddd" }]);
    expect((await reportAnswerCitations(root, "Grounded in [[Raw Name]].")).citations)
      .toMatchObject([{ status: "resolved", pageId: "concepts/Raw Name" }]);

    // PRESERVE: a frontmatter title is still not a resolution target — the reason
    // the old instruction produced dead citations.
    expect((await reportAnswerCitations(root, "Grounded in [[Subdominios DDD]].")).citations)
      .toMatchObject([{ target: "subdominios-ddd", status: "broken" }]);
  });
});
