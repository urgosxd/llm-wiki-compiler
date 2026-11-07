/**
 * Confirms the environment budget reaches every phase of the real compile CLI.
 *
 * `resolveMaxTokens` (`src/utils/llm.ts`) lets an explicit per-call value win over
 * `LLMWIKI_MAX_TOKENS`, so a phase that pins its own number silently ignores the
 * operator's budget. The second case exists because a budget test that never
 * reaches the reference review cannot see the review's request at all: it compiles
 * twice so an earlier page names the article the second run creates, which is the
 * only situation in which that stage calls the model. The earlier page names an
 * ALIAS of the new article on purpose -- a title mention is re-wrapped by the
 * resolver before the review runs, so only an alias leaves a mention for it.
 */
import { writeFile } from "fs/promises";
import path from "path";
import { expect, it } from "vitest";
import { useAimockLifecycle, mockOpenAIEnv, stubCannedCompile } from "./fixtures/aimock-helper.js";
import type { MockClaudeHandle } from "./fixtures/aimock-helper.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("compile-token-budget");

/** The budget every chat request must carry, far enough from any default to be visible. */
const CONFIGURED_BUDGET = "8192";

/** Chat requests only: embeddings travel on their own path and carry no output budget. */
function chatRequests(handle: MockClaudeHandle): Array<{ body?: { max_tokens?: number; tools?: unknown } }> {
  const requests = handle.mock.getRequests() as Array<{
    path: string;
    body?: { max_tokens?: number; tools?: unknown } | null;
  }>;
  return requests.filter((request) => request.path === "/v1/chat/completions")
    .map((request) => ({ ...(request.body === null ? {} : { body: request.body }) }));
}

/**
 * Canned extraction for one source.
 *
 * Two names that the identity rules fold produce ONE article carrying the other as
 * a declared alias, which is the form the reference review can still be offered.
 */
function stubConcepts(handle: MockClaudeHandle, concepts: readonly string[]): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [{
      name: "extract_concepts",
      arguments: {
        concepts: concepts.map((concept) => ({
          concept,
          summary: `Summary of ${concept}.`,
          is_new: true,
          tags: ["budget"],
          confidence: 0.9,
        })),
      },
    }],
  });
}

it("sends the selected output budget for concept extraction and page generation", async () => {
  const handle = await aimock.start();
  stubCannedCompile(handle, "Budget Concept");
  const cwd = await aimock.makeWorkspace("# A source\n\nAn important concept.\n");
  const result = await runCLI(["compile"], cwd, { ...mockOpenAIEnv(handle), LLMWIKI_MAX_TOKENS: CONFIGURED_BUDGET });
  expectCLIExit(result, 0);
  // Anthropic normalization in aimock omits max_tokens; inspect the OpenAI wire shape.
  const requests = chatRequests(handle);
  expect(requests.some((request) => Array.isArray(request.body?.tools))).toBe(true);
  expect(requests.some((request) => !request.body?.tools)).toBe(true);
  expect(requests.every((request) => request.body?.max_tokens === Number(CONFIGURED_BUDGET))).toBe(true);
});

it("sends the selected output budget to the reference review of an earlier page", async () => {
  const handle = await aimock.start();
  const env = { ...mockOpenAIEnv(handle), LLMWIKI_MAX_TOKENS: CONFIGURED_BUDGET };
  stubConcepts(handle, ["Alpha Topic"]);
  handle.mock.onMessage(/.*/, { content: "Alpha Topic mentions Vector Database in passing." });
  const cwd = await aimock.makeWorkspace("# A source\n\nAlpha Topic mentions Vector Database.\n");
  expectCLIExit(await runCLI(["compile"], cwd, env), 0);

  // Second ingest: the earlier page already names the article the run creates, by a
  // spelling the resolver does not wrap, which is what the review exists to judge.
  handle.mock.clearFixtures();
  stubConcepts(handle, ["Vector DB", "Vector Database"]);
  handle.mock.onMessage(/.*/, { content: "Vector DB is an approximate index." });
  handle.mock.onToolCall("judge_reference", {
    toolCalls: [{ name: "judge_reference", arguments: { should_link: true, mention: "Vector Database" } }],
  });
  await writeFile(path.join(cwd, "sources", "beta.md"), "# Another source\n\nVector DB.\n", "utf-8");
  const second = await runCLI(["compile"], cwd, env);
  expectCLIExit(second, 0);

  // Proof the review was really reached, so the budget assertion below is about it.
  expect(second.stdout).toContain("Link review of earlier pages: 1 review(s) of 1 earlier page(s)");
  const reviewed = chatRequests(handle)
    .filter((request) => JSON.stringify(request.body?.tools ?? "").includes("judge_reference"));
  expect(reviewed).not.toHaveLength(0);
  expect(chatRequests(handle).every((request) => request.body?.max_tokens === Number(CONFIGURED_BUDGET))).toBe(true);
});
