/**
 * Slice 5 MCP tests for `get_context_pack`.
 *
 * Lives in a sibling file so `test/mcp-server.test.ts` (which exercises
 * every other MCP tool + resource) stays inside the 400-line ceiling
 * the repo enforces on test files. The contracts pinned here:
 *   - the tool returns the v1 envelope shape and the text content
 *     block parses back to the same `structuredContent.result`
 *   - the MCP payload matches `buildContextPack()` byte-for-byte —
 *     the tool must NOT fork JSON construction
 *   - `omitRoot=true` keeps `project.root` present and `null`
 *   - `includeSources=true` materializes source windows for a
 *     claim-level citation
 *   - the tool works with every provider credential stripped
 *   - the tool does not mutate project files
 *
 * Tests drive the registered handler directly via the McpServer's
 * internal `_registeredTools` map — same pattern as mcp-server.test.ts
 * — so we never spin up an stdio transport.
 *
 * ## Why every call names a Stack, and where the pages live
 *
 * `stackId` is a REQUIRED argument: nothing is inherited from the environment any
 * more, so each case passes the fixture's Stack explicitly. A named Stack resolves
 * its page corpus through the registry seam, which reads Postgres — so the seeded
 * pages are ROWS written with the same sink a compile uses. A `wiki/concepts/*.md`
 * file would be invisible to the tool and every assertion below would then be
 * measuring an empty pack.
 *
 * The Stack is ALSO bound in `process.env` for the duration of each case, exactly as
 * `useQueryStackFixture` does for the query suites. `buildContextPack` derives its
 * project summary and its freshness snapshot from the AMBIENT environment, so a pack
 * built without that binding reports `project.pages: 0` and, seeing an empty project,
 * returns no primary pages at all. Binding it is what makes the pack describe the same
 * corpus the argument named.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { buildContextPack } from "../packages/wiki/src/context/build.js";
import { createPageWriteSink } from "../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { writeWikiStateToRows } from "../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import {
  buildServer,
  callTool,
  snapshotWorkspace,
  useMcpRoot,
} from "./fixtures/mcp-test-env.js";
import { sha256Hex } from "./fixtures/state-json.js";
import { createProbeStack } from "./dimensions/harness-lifecycle.js";
import type { ProbeStack } from "./dimensions/harness-lifecycle.js";

const rootHandle = useMcpRoot("llmwiki-mcp-context");
const rootOf = (): string => rootHandle.value;

let stack: ProbeStack;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  stack = await createProbeStack("mcp-context");
  savedEnv = { ...process.env };
  process.env = { ...savedEnv, ...stack.env() };
});

afterEach(async () => {
  process.env = savedEnv;
  await stack.harness.cleanup();
});

/** The Stack id every call passes as its required argument. */
function stackId(): string {
  return stack.harness.stackId;
}

/**
 * Store one concept page as a ROW on the fixture's Stack.
 *
 * `pageDirectory` is fixed to `concepts` because that is the namespace
 * `wiki.pages` admits.
 *
 * @param slug - Page slug.
 * @param title - Page title.
 * @param summary - Page summary.
 * @param body - Page body, after the generated frontmatter.
 */
async function seedConceptRow(
  slug: string,
  title: string,
  summary: string,
  body: string,
): Promise<void> {
  await createPageWriteSink(stack.harness.db, stack.harness.stackId)({
    directory: "concepts",
    slug,
    body: `---\ntitle: ${title}\nsummary: ${summary}\n---\n\n${body}\n`,
  });
}

/**
 * Suppress every Anthropic/OpenAI credential the host shell might have
 * set so the tool exercises the documented credential-free path.
 * Returns a restorer that puts every value back exactly as it was.
 */
function stripProviderEnv(): () => void {
  const previous: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    LLMWIKI_CLAUDE_SETTINGS_PATH: process.env.LLMWIKI_CLAUDE_SETTINGS_PATH,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(rootOf(), "no-settings.json");
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Seed one concept page and call `get_context_pack` against it.
 * Centralised so the per-test bodies focus on the assertion that
 * differentiates them, and fallow does not flag the seed+call pair
 * as duplication across sibling tests.
 */
async function seedRetrievalAndCall(): Promise<{
  pack: Record<string, unknown>;
  result: Awaited<ReturnType<typeof callTool>>;
}> {
  await seedConceptRow("retrieval", "Retrieval", "How retrieval works", "Body content.");
  const server = buildServer(rootOf());
  const result = await callTool(server, "get_context_pack", {
    prompt: "retrieval",
    stackId: stackId(),
  });
  return {
    pack: result.structuredContent?.result as Record<string, unknown>,
    result,
  };
}

describe("get_context_pack tool", () => {
  it("returns v1 envelope with the stable top-level field set over a seeded wiki page", async () => {
    if (!stack.harness.reachable) return;
    const { pack, result } = await seedRetrievalAndCall();
    expect(pack.version).toBe(1);
    expect(Object.keys(pack)).toEqual([
      "version",
      "prompt",
      "budget",
      "project",
      "primary",
      "neighbors",
      "warnings",
      "gaps",
      "suggestedActions",
    ]);
    // structuredContent and the text content block must agree byte-for-byte.
    expect(JSON.parse(result.content[0].text)).toEqual(pack);
  });

  it("matches buildContextPack() output byte-for-byte for the same inputs", async () => {
    if (!stack.harness.reachable) return;
    const { pack } = await seedRetrievalAndCall();
    const fromCli = await buildContextPack({ root: rootOf(), prompt: "retrieval" });
    expect(pack).toEqual(fromCli);
  });

  it("omitRoot=true keeps project.root present and sets it to null", async () => {
    if (!stack.harness.reachable) return;
    await seedConceptRow("alpha", "Alpha", "", "body");
    const server = buildServer(rootOf());
    const result = await callTool(server, "get_context_pack", {
      prompt: "alpha",
      omitRoot: true,
      stackId: stackId(),
    });
    const pack = result.structuredContent?.result as { project: Record<string, unknown> };
    expect(Object.keys(pack.project)).toContain("root");
    expect(pack.project.root).toBeNull();
  });

  it("includeSources=true materializes sourceWindows for a claim-level citation", async () => {
    if (!stack.harness.reachable) return;
    const root = rootOf();
    await seedConceptRow("alpha", "Alpha", "", "Cited prose. ^[paper.md:2-4]");
    // Source TEXT is never a row: `materializeSourceWindows` reads `sources/<file>`.
    await writeFile(
      path.join(root, "sources", "paper.md"),
      ["one", "two", "three", "four", "five"].join("\n"),
      "utf-8",
    );
    const server = buildServer(root);
    const result = await callTool(server, "get_context_pack", {
      prompt: "alpha",
      includeSources: true,
      stackId: stackId(),
    });
    const pack = result.structuredContent?.result as {
      primary: Array<{ sourceWindows: Array<Record<string, unknown>> }>;
    };
    expect(pack.primary[0].sourceWindows).toEqual([
      { file: "paper.md", start: 2, end: 4, text: "two\nthree\nfour" },
    ]);
  });

  it("works without provider credentials (semantic retrieval falls back silently)", async () => {
    if (!stack.harness.reachable) return;
    await seedConceptRow("alpha", "Alpha", "", "body");
    const restore = stripProviderEnv();
    try {
      const server = buildServer(rootOf());
      const result = await callTool(server, "get_context_pack", {
        prompt: "alpha",
        stackId: stackId(),
      });
      const pack = result.structuredContent?.result as { version: number };
      expect(pack.version).toBe(1);
    } finally {
      restore();
    }
  });

  it("does not mutate project files", async () => {
    if (!stack.harness.reachable) return;
    const root = rootOf();
    await seedConceptRow("alpha", "Alpha", "", "body");
    const beforeFiles = await snapshotWorkspace(root);
    const server = buildServer(root);
    await callTool(server, "get_context_pack", { prompt: "alpha", stackId: stackId() });
    const afterFiles = await snapshotWorkspace(root);
    expect(afterFiles).toEqual(beforeFiles);
  });

  it("get_context_pack surfaces freshnessStatus on primary pages", async () => {
    if (!stack.harness.reachable) return;
    // State records OLD hash; the Stack's current document hashes differ → stale.
    //
    // Both the compile state and the source corpus live where a Stack keeps them:
    // in rows. Writing `.llmwiki/state.json` and `sources/a.md` would be invisible
    // here — the state read and the hash pass both follow `AKS_STACK_ID`.
    // The document row has to exist FIRST: `wiki.source_compile_state` carries a
    // foreign key onto it, so the compile state can only describe a document the
    // Stack really holds.
    await saveSourceDocument(stack.harness.db, stack.harness.stackId, {
      title: "A",
      document: "NEW body",
      source: "a.md",
    });
    await writeWikiStateToRows(stack.harness.db, stack.harness.stackId, {
      version: 1,
      indexHash: "",
      sources: {
        "a.md": {
          hash: sha256Hex("OLD body"),
          concepts: ["topic"],
          compiledAt: "2024-01-03T00:00:00.000Z",
        },
      },
    });
    await seedConceptRow("topic", "Topic", "The topic page", "A topic page body.");
    const server = buildServer(rootOf());
    const result = await callTool(server, "get_context_pack", {
      prompt: "topic",
      stackId: stackId(),
    });
    const pack = result.structuredContent?.result as {
      primary: Array<{ id: string; freshnessStatus: string }>;
    };
    const primary = pack.primary.find((p) => p.id.endsWith("topic"));
    expect(primary).toBeDefined();
    expect(primary?.freshnessStatus).toBe("stale");
  });
});
