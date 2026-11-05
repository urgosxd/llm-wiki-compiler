/**
 * First real MCP-over-stdio integration test for llmwiki.
 *
 * Previous MCP tests drive registered handlers in-process (no transport). This
 * file spawns the actual `llmwiki serve --root <tmp>` binary over stdio, connects
 * an SDK Client via StdioClientTransport, and calls `wiki_status` through the
 * full JSON-RPC stack — verifying the pending-review count from a seeded candidate.
 *
 * The candidate is stored as a ROW on the probe Stack, through the same store
 * production writes with, so no LLM is needed and the test is fully deterministic.
 * A candidate FILE in `.llmwiki/candidates/` would be invisible here: the queue the
 * tool counts is the named Stack's rows. `wiki_status` is read-only and never calls
 * a provider, so no API key is required.
 *
 * `stackId` is a REQUIRED tool argument, so the call names a real Stack. The
 * argument is passed per request and is deliberately NOT bound in the subprocess
 * environment: the candidate queue is resolved from the environment the tool call
 * builds, and binding a Stack in the subprocess would replace the corpus that keeps
 * reads in this test's own database — the exact trap `test-dotenv.ts` documents.
 * The oracle is the pendingCandidates count of the Stack the call names.
 */

import { describe, it, expect } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useMcpRoot, connectMcpClient, parseToolPayload } from "./fixtures/mcp-test-env.js";
import { useStatusStackFixture } from "./fixtures/stack-status-fixtures.js";

const rootHandle = useMcpRoot("mcp-stdio");

/**
 * The probe Stack whose pending candidates the subprocess counts. Seeded through the
 * production candidate store — see `test/fixtures/stack-status-fixtures.ts`.
 */
const fixture = useStatusStackFixture("mcp-stdio");

/**
 * One pending candidate, as the page the reviewer would approve.
 *
 * @param now - Timestamp shared by the frontmatter and the stored record.
 */
function pendingCandidate(now: string) {
  return {
    id: "alpha-deadbeef",
    title: "Alpha",
    slug: "alpha",
    summary: "Alpha summary.",
    sources: ["intro.md"],
    body: `---\ntitle: Alpha\nsummary: Alpha summary.\nsources: []\ncreatedAt: '${now}'\nupdatedAt: '${now}'\n---\n\n# Alpha\n\nAlpha summary.`,
  };
}

describe("MCP stdio: wiki_status pending-review count", () => {
  it("reports pendingCandidates ≥ 1 after seeding a candidate row", async () => {
    const { stackId, reachable, seedPendingCandidates } = fixture();
    if (!reachable) return;
    const root = rootHandle.value;
    const now = new Date().toISOString();
    await seedPendingCandidates([pendingCandidate(now)]);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({
        name: "wiki_status",
        arguments: { stackId },
      });
      const status = parseToolPayload<{ pendingCandidates: number }>(result as CallToolResult);
      expect(status.pendingCandidates).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
