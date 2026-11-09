/**
 * @file test/mcp/query-wiki-reads-rows.test.ts
 * @description `query_wiki` answers from Postgres, not from `wiki/` on disk.
 *
 * ## The condition this pins
 *
 * `query_wiki` reaches its pages through `withRegistrySource`, which returns a
 * row-backed source when `AKS_STACK_ID` is set and `undefined` (the disk path) when
 * it is not. If that seam regressed — or if the tool stopped passing the source it
 * receives into `generateAnswer` — the tool would fall back to scanning
 * `wiki/<namespace>` and find nothing, because a Stack-backed project has no page
 * files at all.
 *
 * Every test therefore runs against a root with NO `wiki/` directory, and the pages
 * exist only as rows. A disk read cannot produce a passing answer.
 *
 * ## Why the tool is called through the registry, not a helper
 *
 * A helper that builds its own environment would never consult the `stackId`
 * argument, so it would pass while the wiring under test was broken. Calling the
 * registered tool is the only way to exercise what a caller actually hits.
 *
 * ## Why every case here passes the Stack explicitly
 *
 * `stackId` is a required argument now: a tool call inherits no Stack from the
 * environment, so a call that omitted it would be refused by the schema before
 * reaching the row path this file measures. The omission itself is pinned in
 * `stack-argument-required-refusal.test.ts` rather than here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rowOnlyProviderModule, seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { useQueryStackFixture } from "../fixtures/query-stack-root.js";
import type { QueryStackFixture } from "../fixtures/query-stack-root.js";

/**
 * The page the stubbed selector picks; it only exists as a row.
 *
 * `vi.hoisted` because the `vi.mock` factory below runs while this file's imports are
 * being linked — before a module-body `const` would be initialized — and the factory
 * has to capture the id at that moment.
 */
const SELECTED_PAGE_ID = vi.hoisted(() => "concepts/row-only-page");

/** Body that can only come from Postgres: no file holds this text. */
const ROW_ONLY_BODY = "ROW_ONLY_BODY_never_written_to_disk";

/**
 * Stub the LLM boundary only: page selection and the answer text.
 *
 * Retrieval, the registry seam, the tenant bind and the row reads stay production
 * code, because they are what this file measures. The selector returns one qualified
 * page id, which is how the real model answers when it picks from the candidate list.
 */
vi.mock("../../packages/wiki/src/utils/llm.js", () => rowOnlyProviderModule(SELECTED_PAGE_ID));

/** Seed one page into the Stack through the same sink a compile uses. */
async function seedRowOnlyPage(fixture: QueryStackFixture): Promise<void> {
  await seedConceptPage(
    fixture.stack.harness,
    "row-only-page",
    `---\ntitle: Row Only\nsummary: lives in postgres\n---\n\n${ROW_ONLY_BODY}\n`,
  );
}

/** Put a compiled page on disk only, to prove the row path does not read it. */
async function seedDiskPage(root: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(
    path.join(root, "wiki/concepts/disk-only.md"),
    `---\ntitle: Disk Only\nsummary: on disk\n---\n\nDISK_ONLY_BODY\n`,
    "utf-8",
  );
}

/**
 * Seed the row page and return a server bound to the fixture's Stack.
 *
 * The two "answers from rows" cases differ only in which StackId they pass, so the
 * seeding and server construction are shared rather than repeated.
 */
async function prepareRowBackedServer(fixture: QueryStackFixture): Promise<McpServer> {
  await seedRowOnlyPage(fixture);
  return buildServer(fixture.root);
}

/** Ask the registered tool one question and return the parsed answer payload. */
async function askViaTool(
  server: McpServer,
  args: Record<string, unknown>,
): Promise<{ answer?: string; pageIds?: string[] }> {
  const envelope = await callTool(server, "query_wiki", args);
  return JSON.parse(envelope.content[0]?.text ?? "{}") as {
    answer?: string;
    pageIds?: string[];
  };
}

describe("query_wiki reads pages from rows", () => {
  const fixture = useQueryStackFixture("qwr", "query-rows-");

  beforeEach(() => {
    vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers from rows for the Stack named in the argument", async () => {
    const { stack } = fixture();
    if (!stack.harness.reachable) return;
    const server = await prepareRowBackedServer(fixture());

    const result = await askViaTool(server, {
      question: "what is row only?",
      stackId: stack.harness.stackId,
    });

    // The answer and the citation both come from the row. A disk fallback would
    // report "No eligible pages" and never reach the provider.
    expect(result.answer).toContain("ANSWER_FROM_ROWS");
    expect(result.pageIds).toContain(SELECTED_PAGE_ID);
  }, 60_000);

  it("does not fall back to disk when the Stack has no pages", async () => {
    const { stack, root } = fixture();
    if (!stack.harness.reachable) return;
    // A page exists ONLY on disk. With a Stack bound the row source answers, so this
    // file stays invisible; reading it would mean the disk fallback ran.
    await seedDiskPage(root);
    const server = buildServer(root);

    await expect(
      askViaTool(server, { question: "what is on disk?", stackId: stack.harness.stackId }),
    ).rejects.toThrow(/No compiled pages found/);
  }, 60_000);
});
