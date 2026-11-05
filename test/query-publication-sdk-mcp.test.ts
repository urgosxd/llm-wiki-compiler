/**
 * SDK and registered MCP query handlers share real publication policy. Only the
 * provider boundary is stubbed; admission, profile, output scopes, and writes are
 * production code. The MCP schema remains save-only with no review option.
 *
 * The two surfaces read DIFFERENT backends, on purpose. `createWiki`/`queryCommand`
 * resolve their corpus from `process.env`, which is left unbound, so the SDK cases
 * keep exercising the staged `wiki/` tree. `query_wiki` takes a REQUIRED `stackId`,
 * and a named Stack resolves its pages and its review candidates from Postgres — so
 * the MCP cases seed those same rows on a provisioned Stack and pass its id.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWiki, ProviderUnavailableError, type QueryResult } from "../src/index.js";
import queryCommand, { generateAnswer } from "../src/commands/query.js";
import { saveStoredCandidate } from "../src/dimensions/wiki/candidate-store.js";
import { journalEntries, seedConceptPage } from "./fixtures/mcp-stack-rows.js";
import { callClaude } from "../src/utils/llm.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { stageCitationWorkspace, citationWorkspaceBytes } from "./fixtures/query-answer-citations.js";
import { SAMPLE_PROFILE } from "./fixtures/profile-fixtures.js";
import { buildServer } from "./fixtures/mcp-test-env.js";
import { createProbeStack } from "./dimensions/harness-lifecycle.js";
import type { ProbeStack } from "./dimensions/harness-lifecycle.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));
const ctx = useTempRoot();

let stack: ProbeStack;

beforeEach(async () => {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.stubEnv("VOYAGE_API_KEY", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("LLMWIKI_CLAUDE_SETTINGS_PATH", path.join(ctx.dir, "no-settings.json"));
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  await stageCitationWorkspace(ctx.dir);
  answerWith("Retained [[alpha]].");
  stack = await createProbeStack("query-publication-mcp");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await stack.harness.cleanup();
});

/**
 * Mirror the staged workspace into the fixture Stack's rows.
 *
 * A Stack-scoped query reads its corpus and its pending candidates from Postgres, so
 * the staged `wiki/concepts/alpha.md` file and `.llmwiki/candidates/pending-beta.json`
 * are invisible to it. Both are seeded through the same stores production uses, which
 * is what keeps the citation report below (resolved / pending / broken) meaningful.
 *
 * @param probe - The provisioned Stack to seed.
 */
async function seedStackCorpus(probe: ProbeStack): Promise<void> {
  await seedConceptPage(
    probe.harness,
    "alpha",
    "---\ntitle: Alpha\nsummary: Retained grounding\nsources: []\n---\nAlpha body.\n",
  );
  await saveStoredCandidate(probe.harness.db, probe.harness.stackId, {
    id: "pending-beta",
    slug: "beta",
    title: "Beta",
    summary: "Pending",
    sources: [],
    body: "Beta body.",
    generatedAt: "2026-09-18T00:00:00Z",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  });
}

/**
 * The journal headings `stackId` holds, rendered as `operation | description`.
 *
 * @param stackId - The Stack whose journal to read.
 * @returns Heading lines, oldest first.
 */
async function journalHeadings(stackId: string): Promise<string[]> {
  return (await journalEntries(stackId)).map((entry) => `${entry.operation} | ${entry.description}`);
}

/**
 * The deployment's journal: `log.md` at the project root, or empty when absent.
 *
 * @param root - Project root directory.
 * @returns The whole file, or `""` when this deployment wrote no file journal.
 */
async function deploymentJournal(root: string): Promise<string> {
  return readFile(path.join(root, "log.md"), "utf8").catch(() => "");
}

/** Stub the two provider requests without replacing retrieval or publication. */
function answerWith(answer: string): void {
  vi.mocked(callClaude).mockReset().mockImplementation(async (options) => {
    if (options.tools) return JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Alpha" });
    options.onToken?.(answer);
    return answer;
  });
}

it("validates review before missing credentials at SDK, command, and generation entrypoints", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const wiki = createWiki({ root: ctx.dir });
  await expect(wiki.query("Explain alpha", { review: true })).rejects.toThrow("Query review requires save.");
  await expect(wiki.query("Explain alpha")).rejects.toBeInstanceOf(ProviderUnavailableError);
  await expect(queryCommand("/missing-wiki", "Explain alpha", { review: true })).rejects.toThrow("Query review requires save.");
  expect(callClaude).not.toHaveBeenCalled();
});

it.each([
  { save: true, review: false, answer: "Retained [[alpha]].", field: "saved" },
  { save: true, review: true, answer: "Pending [[beta]].", field: "candidateId" },
  { save: true, review: false, answer: "Pending [[beta]].", field: "publicationRefusal" },
  { save: false, review: false, answer: "Broken [[missing]].", field: undefined },
])("returns distinct quiet SDK result $field", async ({ save, review, answer, field }) => {
  answerWith(answer);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write");
  const stderr = vi.spyOn(process.stderr, "write");
  const { query } = createWiki({ root: ctx.dir });
  const result = await query("Explain alpha", { save, review });
  expect(result.answer).toBe(answer);
  for (const key of ["saved", "candidateId", "publicationRefusal"] as const) {
    if (key === field) expect(result[key]).toBeTruthy();
    else expect(result).not.toHaveProperty(key);
  }
  expect(callClaude).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});


it("stages quietly in a profile-enabled project because the candidate is the trust-routed destination", async () => {
  await writeFile(path.join(ctx.dir, ".llmwiki/profile.json"), JSON.stringify(SAMPLE_PROFILE));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await createWiki({ root: ctx.dir }).query("Explain alpha", { save: true, review: true });
  expect(result.answer).toBe("Retained [[alpha]].");
  expect(result.publicationRefusal).toBeUndefined();
  expect(result.saved).toBeUndefined();
  expect(result.candidateId).toBeTypeOf("string");
  await expect(readFile(path.join(ctx.dir, "wiki/queries/explain-alpha.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(log).not.toHaveBeenCalled();
  expect(callClaude).toHaveBeenCalledTimes(2);
});

it("propagates an actual SDK save failure", async () => {
  await mkdir(path.join(ctx.dir, "wiki/queries/explain-alpha.md"));
  await expect(createWiki({ root: ctx.dir }).query("Explain alpha", { save: true })).rejects.toMatchObject({ code: "EISDIR" });
  expect(callClaude).toHaveBeenCalledTimes(2);
});

it.each([false, true])("real MCP query returns the answer with save=%s and observable refusal only when requested", async (save) => {
  if (!stack.harness.reachable) return;
  await seedStackCorpus(stack);
  answerWith("Both [[beta]] [[missing]].");
  const before = await citationWorkspaceBytes(ctx.dir);
  const server = buildServer(ctx.dir);
  const client = new Client({ name: "publication-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const query = (await client.listTools()).tools.find((tool) => tool.name === "query_wiki")!;
  expect(query.inputSchema.properties).toHaveProperty("save");
  expect(query.inputSchema.properties).not.toHaveProperty("review");
  const envelope = await client.callTool({
    name: "query_wiki",
    arguments: { question: "Explain alpha", save, stackId: stack.harness.stackId },
  });
  const result = (envelope.structuredContent as { result: QueryResult }).result;
  expect(result.answer).toBe("Both [[beta]] [[missing]].");
  expect(result.saved).toBeUndefined();
  expect(result.candidateId).toBeUndefined();
  if (save) {
    expect(result.publicationRefusal).toMatchObject({ code: "broken", targets: ["missing"] });
    expect(result.publicationRefusal?.message).toContain("pending citation targets: beta");
  } else expect(result).not.toHaveProperty("publicationRefusal");
  const content = envelope.content as Array<{ type: string; text: string }>;
  expect(JSON.parse(content[0].text)).toEqual(result);
  expect(await citationWorkspaceBytes(ctx.dir)).toEqual(before);
  // Both sides, because either alone passes for the wrong reason. The entry IS in the
  // journal of the Stack the call named...
  expect(await journalHeadings(stack.harness.stackId)).toEqual(["query | Explain alpha"]);
  // ...and it is NOT in the deployment's journal. That is `log.md`, which is what a
  // project whose environment binds no Stack writes; nothing else in the workspace
  // changed above, so the file must not have gained the entry.
  expect(await deploymentJournal(ctx.dir)).not.toContain("query | Explain alpha");
  expect(callClaude).toHaveBeenCalledTimes(2);
  await client.close();
  await server.close();
});
