/**
 * MCP-over-stdio integration tests for the OKF export tool.
 *
 * Mirrors `test/mcp-stdio.test.ts`: each test spawns the actual
 * `llmwiki serve --root <tmp>` binary over stdio, connects an SDK Client via
 * StdioClientTransport, and drives a tool through the full JSON-RPC stack.
 * Covers `export_okf` (happy path) and its path confinement — the paths a fake
 * in-process `registerTool` can't exercise. Neither calls an LLM, so no API key is
 * required.
 *
 * There is no `import_okf` to cover: it hardcoded `trusted: false` and its schema had
 * no `trusted` field, so it could only ever stage, and staging is retired because no
 * surface promotes a candidate into the wiki.
 *
 * Root isolation: each `describe` owns its OWN `useMcpRoot` handle, and
 * `useMcpRoot` reassigns the root via `beforeEach` so every `it` gets a fresh
 * temp dir.
 *
 * ONE Stack per FILE, named in every call. The tool requires the argument, and a
 * Stack id is only usable when a row carries it, so the suite provisions one and
 * shares it. The cases are skipped, not softened, when no test database is up —
 * an absent Stack would make every call a refusal and prove nothing.
 */

import { describe, it, expect, afterAll } from "vitest";
import { stat } from "fs/promises";
import path from "path";
import { useMcpRoot, connectMcpClient } from "./fixtures/mcp-test-env.js";
import { createPageWriteSink } from "../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { createProbeStack } from "./dimensions/harness-lifecycle.js";

/** The Stack every call in this file names explicitly. */
const stack = await createProbeStack("okf-mcp-stdio");

/** Stack id the OKF tools are given, now that they require one. */
const stackId = stack.harness.stackId;

/** Skip needs the database: an unknown id is a refusal, not a bundle. */
const needsStack = !stack.harness.reachable;

afterAll(async () => {
  await stack.harness.cleanup();
});

/** Store one concept page as a row on the suite's Stack, so the bundle has content. */
async function seedStackPage(): Promise<void> {
  await createPageWriteSink(stack.harness.db, stackId)({
    directory: "concepts",
    slug: "rag",
    body: "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n",
  });
}

describe("MCP stdio: export_okf produces a bundle", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-export");
  it.skipIf(needsStack)("writes an OKF bundle to disk and returns a non-error response", async () => {
    const root = rootHandle.value;
    await seedStackPage();

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "export_okf", arguments: { stackId } });
      expect(result.isError).toBeFalsy();
      expect((await stat(path.join(root, "dist/exports/okf/index.md"))).isFile()).toBe(true);
      // The named Stack's row, not any file on disk: the root has no `wiki/` page.
      expect((await stat(path.join(root, "dist/exports/okf/concepts/rag.md"))).isFile()).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("MCP stdio: export_okf confines agent-supplied paths", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-confine");
  it.skipIf(needsStack)("rejects an export out that escapes the root", async () => {
    const root = rootHandle.value;

    const { client, transport } = await connectMcpClient(root);
    try {
      const exportEscape = await client.callTool({ name: "export_okf", arguments: { out: "../escape", stackId } });
      expect(exportEscape.isError).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
