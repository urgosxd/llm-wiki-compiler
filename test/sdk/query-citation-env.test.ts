/**
 * @file test/sdk/query-citation-env.test.ts
 * @description The SDK facade's `query` resolves its answer-citation index from the
 * environment the CALLER captured, never from the process it happens to run in.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:86`) and
 * forwards it to `ingest`/`compile`/`search`/`getPage`/`listPages`/`status`/`lint`.
 * `query` opened its registry source with that environment but called
 * `generateAnswer(root, question, { ...opts, registrySource })` WITHOUT it, and
 * `generateAnswer` resolves the citation index through
 * `withRawPageSource(root, options.env ?? process.env, …)` (`commands/query.ts:230`).
 *
 * So a handle bound to Stack B computed its verdicts from Stack A's rows whenever the
 * process itself served Stack A: the page only A has came back `resolved` carrying
 * A's `pageId` — another tenant's page identity — while the page the answer was
 * actually grounded in came back `broken`. The MCP tool
 * (`mcp/wiki-read-tools.ts:102-114`) and the CLI (`commands/query.ts:349-360`) both
 * pass an environment; the SDK door was the one that did not.
 *
 * ## Why the case compares the WHOLE citation array
 *
 * A report is a snapshot of every recognized target in first-occurrence order.
 * Asserting only "resolved" passes when the index invents entries; asserting only
 * "broken" passes when the index is empty. One answer body therefore cites a page
 * that exists in the handle's Stack and a page that exists only in the other one, and
 * both verdicts are compared.
 *
 * ## Why the tree has no `wiki/` directory
 *
 * The root is a real temporary directory with no `wiki/` tree (asserted below), so no
 * case can pass by scanning files: every page these assertions resolve exists only as
 * a `wiki.pages` row. The two Stacks are provisioned through the shared lifecycle
 * fixture, and block only on the mocked LLM module — no provider spend.
 */
import { afterAll, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import { seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";

// The answer is deterministic and local: the LLM module is the only provider seam the
// query crosses, so mocking it is what keeps this proof offline. `tools` is present on
// the selection call and absent on the answer call.
const P = vi.hoisted(() => ({
  answer: "Grounded in [[alpha-b]] and [[alpha-a]].",
  selected: "concepts/alpha-b",
}));

vi.mock("../../packages/wiki/src/utils/llm.js", () => ({
  callClaude: vi.fn(async (options: { tools?: unknown }) =>
    options.tools
      ? JSON.stringify({ pages: [P.selected], reasoning: "the row page" })
      : P.answer,
  ),
}));

/** A page body in the shape the compiler writes, with frontmatter. */
function pageBody(title: string, slug: string): string {
  return `---\ntitle: ${title}\nsummary: only this Stack holds ${slug}\n---\n\nOnly this Stack holds ${slug}.\n`;
}

const ambient = await createProbeStack("sdk-citation-env-ambient");
const bound = await createProbeStack("sdk-citation-env-bound");
const root = await mkdtemp(path.join(os.tmpdir(), "sdk-citation-env-"));

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await ambient.harness.cleanup();
  await bound.harness.cleanup();
});

it("resolves citations from the Stack the handle names, never the ambient one", async () => {
  expect(
    ambient.harness.reachable && bound.harness.reachable,
    "no database reached this worker: the cross-tenant citation proof is void",
  ).toBe(true);
  // No `wiki/` tree at all: no verdict below can come from a disk scan.
  await expect(readdir(path.join(root, "wiki"))).rejects.toThrow(/ENOENT/);

  await seedConceptPage(
    ambient.harness,
    "alpha-a",
    pageBody("Alpha A", "alpha-a"),
  );
  await seedConceptPage(
    bound.harness,
    "alpha-b",
    pageBody("Alpha B", "alpha-b"),
  );

  // The process serves Stack A; the handle names Stack B.
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  vi.stubEnv("AKS_DATABASE_URL", String(ambient.env().AKS_DATABASE_URL));
  vi.stubEnv("AKS_STACK_ID", ambient.harness.stackId);

  const wiki = createWiki({ root, env: bound.env() });
  const result = (await wiki.query("what is alpha?")) as {
    pageIds?: string[];
    answerCitations?: {
      citations: { target: string; status: string; pageId?: string }[];
    };
  };

  expect(result.pageIds).toEqual(["concepts/alpha-b"]);
  expect(result.answerCitations?.citations).toEqual([
    { target: "alpha-b", status: "resolved", pageId: "concepts/alpha-b" },
    { target: "alpha-a", status: "broken" },
  ]);
}, 60_000);
