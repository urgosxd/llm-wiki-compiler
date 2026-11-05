/**
 * @file test/mcp/tools-list-requires-stack.test.ts
 * @description S1: `stackId` is REQUIRED in every Stack-scoped tool schema.
 *
 * ## Why this goes through `tools/list` and not through the tool handlers
 *
 * The schema is the contract a client reads BEFORE it calls anything: an agent builds
 * its arguments from `tools/list`. A handler that happens to work when the argument is
 * absent proves nothing about what the client was told, and the previous defect was
 * exactly that gap — handlers silently substituted the bound Stack while the schema
 * advertised the argument as optional.
 *
 * So the handshake here is real: a `Client` and an `McpServer` connected over the
 * SDK's in-memory transport, and the assertion is on the JSON Schema that comes back.
 *
 * ## Why three tools are named and excluded
 *
 * `ingest_source`, `export_okf` and `import_okf` take no Stack argument at all today.
 * They are deliberately NOT asserted here: making them take one is a different task,
 * and pinning their current shape would either pre-commit that task or fail it. So the
 * inventory test asserts no TOTAL and no exact name set — it only requires that a tool
 * outside this exemption never ships an optional Stack. When a later task gives any of
 * the three a required `stackId`, the exemption simply stops being needed.
 *
 * ## Why `list_stacks` is asserted the OTHER way
 *
 * It is exempt by ruling, not by oversight: a discovery tool cannot require the
 * identifier of the thing it discovers. It therefore gets its own case pinning the
 * exemption — property present, still optional, still documented as "Omit for the bound
 * Stack" — so the difference reads as a decided contract rather than an argument
 * somebody forgot to migrate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../fixtures/mcp-test-env.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** The ten tools that must carry a REQUIRED Stack: the whole Stack-scoped surface. */
const STACK_SCOPED_TOOLS = [
  "compile_wiki",
  "run_eval",
  "query_wiki",
  "search_pages",
  "read_page",
  "lint_wiki",
  "wiki_status",
  "get_context_pack",
  "ingest_job_status",
  "ingest_jobs_list",
] as const;

/**
 * The wiki tools whose Stack argument is NOT required today, and why.
 *
 * `ingest_source`, `export_okf` and `import_okf` take no Stack at all yet — other tasks
 * own each of them. `list_stacks` takes one but keeps it optional by ruling: a
 * discovery tool cannot require the identifier of the thing it discovers.
 */
const STACK_ARG_NOT_REQUIRED = [
  "ingest_source",
  "export_okf",
  "import_okf",
  "list_stacks",
] as const;

/** Phrases the shared schema description must carry, per S6's recorded asymmetry. */
const REQUIRED_PHRASES = ["required", "no default", "no fallback", "resources", "server environment"];

/** The subset of a `tools/list` entry this file reads. */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema: {
    required?: string[];
    properties?: Record<string, { type?: string; description?: string }>;
  };
}

let root: string;

beforeEach(async () => {
  root = await scratchProjectRoot("tools-list-stack-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Drive a real `tools/list` handshake and hand the result to `read`.
 *
 * @param read - Receives every registered tool, keyed by name.
 * @returns Whatever `read` returned.
 */
async function withListedTools<T>(read: (tools: Map<string, ListedTool>) => T): Promise<T> {
  const server: McpServer = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-list-requires-stack", version: "0" });
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return read(new Map(listed.tools.map((tool) => [tool.name, tool as ListedTool])));
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tools/list declares the Stack argument required", () => {
  it("lists stackId in the required array of every Stack-scoped tool", async () => {
    const required = await withListedTools((tools) =>
      STACK_SCOPED_TOOLS.map((name) => ({ name, required: tools.get(name)?.inputSchema.required ?? [] })),
    );

    for (const { name, required: fields } of required) {
      expect(fields, `${name} must require stackId`).toContain("stackId");
    }
  });

  it("requires stackId on every registered tool outside the exempt set", async () => {
    const unclassified = await withListedTools((tools) =>
      [...tools.keys()]
        .filter((name) => !(STACK_ARG_NOT_REQUIRED as readonly string[]).includes(name))
        .filter((name) => !(tools.get(name)?.inputSchema.required ?? []).includes("stackId")),
    );

    // Deliberately NO total and no "exactly these names" assertion: `export_okf`,
    // `import_okf` and `ingest_source` are other tasks' to change, and giving them a
    // required `stackId` must not turn this file red for the wrong reason. A tool that
    // ships an optional Stack without being named above still fails here.
    expect(unclassified).toEqual([]);
  });

  it("keeps list_stacks exempt: stackId present, optional and still documented", async () => {
    const listStacks = await withListedTools((tools) => tools.get("list_stacks"));
    const stackId = listStacks?.inputSchema.properties?.stackId;

    // Present: the argument still marks which entry is current.
    expect(stackId).toBeDefined();
    // Optional, NOT required: a discovery tool cannot demand the id it discovers.
    expect(listStacks?.inputSchema.required ?? []).not.toContain("stackId");
    // Still the omission wording `test/mcp/list-stacks.test.ts` is built on.
    expect(stackId?.description ?? "").toContain("Omit for the bound Stack");
  });

  it("states in the shared stackId description that the Stack has no default", async () => {
    const stackId = await withListedTools(
      (tools) => tools.get("read_page")?.inputSchema.properties?.stackId,
    );

    expect(stackId?.type).toBe("string");
    for (const phrase of REQUIRED_PHRASES) {
      expect(stackId?.description ?? "").toContain(phrase);
    }
  });

  it("records the required-argument asymmetry in every affected tool description", async () => {
    const described = await withListedTools((tools) =>
      STACK_SCOPED_TOOLS.map((name) => ({
        name,
        description: tools.get(name)?.description ?? "",
      })),
    );

    for (const { name, description } of described) {
      expect(description, `${name} must record the no-fallback rule`).toContain("no fallback");
      expect(description, `${name} must record the resources asymmetry`).toContain("resources");
    }
  });
});
