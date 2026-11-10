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
 * ## Why the inventory is asserted in full
 *
 * `ingest_source` and `export_okf` used to take no Stack argument at all.
 * All three now declare a required `stackId`, verified through the same real handshake:
 * the exemption that once covered them is gone, so the ONE tool allowed to omit the
 * required Stack is `list_stacks`, by S8. The full-inventory case below walks every
 * tool the shared fixture registers, and a separate case proves that walk sees the same
 * inventory as the production factory (`createWikiMcpServer`) — the fixture used to
 * leave the two OKF tools out, which made every fixture-based `tools/list` walk blind
 * to exactly the tools a lost required Stack would break first. A silent loss of a
 * required Stack now fails here instead of surfacing later at a client that built its
 * arguments from `tools/list`.
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
import { createWikiMcpServer } from "../../packages/wiki/src/mcp/server.js";
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
 * The wiki tools whose Stack argument is NOT required, and why.
 *
 * Exactly one: `list_stacks` takes `stackId` but keeps it optional by ruling (S8) — a
 * discovery tool cannot require the identifier of the thing it discovers. It is the
 * only remaining exemption; `ingest_source` and `export_okf` both require
 * `stackId` now.
 */
const STACK_ARG_NOT_REQUIRED = ["list_stacks"] as const;

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
 * @param build - Server factory. Defaults to the shared test fixture, which registers
 *   the same inventory as the production factory: the wiki tools, the resources and
 *   both OKF tools. The full-inventory case leaves this default in place, and the
 *   parity case walks both builders to prove the fixtures cannot drift apart.
 * @returns Whatever `read` returned.
 */
async function withListedTools<T>(
  read: (tools: Map<string, ListedTool>) => T,
  build: (root: string) => McpServer = buildServer,
): Promise<T> {
  const server: McpServer = build(root);
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

    // No total and no "exactly these names" assertion: the exempt set is the data, and
    // a tool that ships an optional Stack without being named in it fails here.
    expect(unclassified).toEqual([]);
  });

  it("requires stackId on EVERY tool the shared fixture registers, except list_stacks", async () => {
    const inventory = await withListedTools((tools) =>
      [...tools.entries()].map(([name, tool]) => ({
        name,
        required: tool.inputSchema.required ?? [],
        stackId: tool.inputSchema.properties?.stackId,
      })),
    );

    // Coverage guard first: a walk that saw only a handful of tools would satisfy the
    // rule below without pinning anything, so every tool whose required Stack this
    // case claims to cover has to be in the walked inventory.
    const walked = inventory.map((tool) => tool.name);
    for (const name of [...STACK_SCOPED_TOOLS, "ingest_source", "export_okf"]) {
      expect(walked, `${name} must be in the walked inventory`).toContain(name);
    }

    // Then the rule, in both directions: a Stack-scoped tool that silently loses its
    // required `stackId`, and `list_stacks` silently gaining one, both fail here.
    const wrong = inventory.filter(
      (tool) => tool.required.includes("stackId") === (tool.name === "list_stacks"),
    );
    expect(wrong.map((tool) => tool.name)).toEqual([]);
    // `list_stacks` declares the argument, optionally: it marks the current entry.
    expect(inventory.filter((tool) => tool.name === "list_stacks")[0]?.stackId).toBeDefined();
  });

  it("walks the same inventory the production factory registers", async () => {
    // The guard that keeps THIS file from going blind: every case above walks the
    // shared fixture, so if that fixture ever stops registering a tool the production
    // factory serves, the coverage they assert quietly shrinks. Both builders are
    // walked here and compared, with the OKF export tool named explicitly because it
    // is one a required-Stack regression would break first.
    const fixtureTools = await withListedTools((tools) => [...tools.keys()].sort());
    const productionTools = await withListedTools(
      (tools) => [...tools.keys()].sort(),
      (dir) => createWikiMcpServer({ root: dir, version: "0" }),
    );

    expect(fixtureTools).toEqual(productionTools);
    for (const name of ["export_okf"]) {
      expect(fixtureTools, `${name} must be in the fixture walk`).toContain(name);
    }
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
