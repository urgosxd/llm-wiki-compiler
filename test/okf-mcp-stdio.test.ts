/**
 * MCP-over-stdio integration tests for the OKF tools.
 *
 * Mirrors `test/mcp-stdio.test.ts`: each test spawns the actual
 * `llmwiki serve --root <tmp>` binary over stdio, connects an SDK Client via
 * StdioClientTransport, and drives a tool through the full JSON-RPC stack.
 * Covers `export_okf` (happy path), and `import_okf` staging, path-confinement
 * rejection, and dry-run — the paths a fake in-process `registerTool` can't
 * exercise. None of these tools call an LLM, so no API key is required.
 *
 * Root isolation: each `describe` owns its OWN `useMcpRoot` handle, and
 * `useMcpRoot` reassigns the root via `beforeEach` so every `it` gets a fresh
 * temp dir. The staging test (writes a candidate) and the dry-run test (asserts
 * zero candidates) therefore never share a root.
 *
 * ONE Stack per FILE, named in every call. Both tools require the argument, and a
 * Stack id is only usable when a row carries it, so the suite provisions one and
 * shares it: it holds no state of its own (the export case seeds it, the import
 * cases only need it to exist), and the subprocess reaches the same database the
 * fixture does. The cases are skipped, not softened, when no test database is up —
 * an absent Stack would make every call a refusal and prove nothing.
 */

import { describe, it, expect, afterAll } from "vitest";
import { stat, writeFile, mkdir } from "fs/promises";
import path from "path";
import { useMcpRoot, connectMcpClient } from "./fixtures/mcp-test-env.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { createPageWriteSink } from "../src/dimensions/wiki/page-write-sink.js";
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

/** Write a foreign OKF bundle under `<root>/kb` with one valid concept doc. */
async function writeBundle(root: string): Promise<void> {
  await mkdir(path.join(root, "kb/concepts"), { recursive: true });
  await writeFile(path.join(root, "kb/concepts/a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n", "utf-8");
}

/** Read the JSON payload a tool returned via `jsonResult` (structuredContent.result). */
function payloadOf(result: Awaited<ReturnType<Awaited<ReturnType<typeof connectMcpClient>>["client"]["callTool"]>>): Record<string, unknown> {
  return (result.structuredContent as { result: Record<string, unknown> }).result;
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

describe("MCP stdio: import_okf stages candidates", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-import");
  it.skipIf(needsStack)("stages a candidate and conveys the review gate over the wire", async () => {
    const root = rootHandle.value;
    await writeBundle(root);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "import_okf", arguments: { dir: "kb", stackId } });
      expect(result.isError).toBeFalsy();
      expect((await listCandidates(root)).length).toBe(1);
      expect(payloadOf(result).nextAction).toMatch(/review|approve|staged/i);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("MCP stdio: OKF tools confine agent-supplied paths", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-confine");
  it.skipIf(needsStack)("rejects an import dir and an export out that escape the root", async () => {
    const root = rootHandle.value;

    const { client, transport } = await connectMcpClient(root);
    try {
      const importEscape = await client.callTool({ name: "import_okf", arguments: { dir: "/etc", stackId } });
      expect(importEscape.isError).toBe(true);
      const exportEscape = await client.callTool({ name: "export_okf", arguments: { out: "../escape", stackId } });
      expect(exportEscape.isError).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("MCP stdio: import_okf dry-run stages nothing", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-dryrun");
  it.skipIf(needsStack)("previews without staging and reports dry-run over the wire", async () => {
    const root = rootHandle.value;
    await writeBundle(root);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "import_okf", arguments: { dir: "kb", dryRun: true, stackId } });
      expect(result.isError).toBeFalsy();
      expect(payloadOf(result).mode).toBe("dry-run");
      expect((await listCandidates(root)).length).toBe(0);
      expect(payloadOf(result).nextAction).toMatch(/preview|re-run|dryRun/i);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
