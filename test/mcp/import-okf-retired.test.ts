// test/mcp/import-okf-retired.test.ts
/**
 * @file The MCP server no longer registers `import_okf`.
 *
 * `import_okf` hardcoded `trusted: false` and its schema had no `trusted` field, so
 * once OKF staging was retired the tool could only ever return the refusal. A tool
 * that can only fail advertises something impossible, so its registration is gone.
 *
 * Absence is asserted STRUCTURALLY — against the server's own registry and against
 * the real `tools/list` of a connected client — never against a hand-maintained
 * name list, which would drift and pass while the tool came back.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWikiMcpServer } from "../../packages/wiki/src/mcp/server.js";
import { WIKI_MCP_TOOL_NAMES } from "../../packages/wiki/src/mcp/tool-names.js";
import { useMcpRoot } from "../fixtures/mcp-test-env.js";

const root = useMcpRoot("import-okf-retired");

/** The tool names a real client reads from the production factory's `tools/list`. */
async function listedToolNames(): Promise<string[]> {
  const server = createWikiMcpServer({ root: root.value, version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "import-okf-retired", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("the MCP surface does not advertise import_okf", () => {
  it("is absent from the registry of a freshly built production server", () => {
    const server = createWikiMcpServer({ root: root.value, version: "0" });
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    // Positive control: the walk sees a real registry, so absence below means absence.
    expect(Object.keys(registry)).toContain("export_okf");
    expect(Object.keys(registry)).not.toContain("import_okf");
  });

  it("is absent from the real tools/list a client reads", async () => {
    expect(await listedToolNames()).not.toContain("import_okf");
  });

  it("is absent from the declared inventory too, so the both-ways guard stays honest", () => {
    expect([...WIKI_MCP_TOOL_NAMES]).not.toContain("import_okf");
  });

  it("keeps the declared inventory equal to the registered set", async () => {
    expect((await listedToolNames()).sort()).toEqual([...WIKI_MCP_TOOL_NAMES].sort());
  });
});
