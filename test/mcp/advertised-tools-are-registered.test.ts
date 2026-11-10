/**
 * @file test/mcp/advertised-tools-are-registered.test.ts
 * @description S3 + S5: the server's `instructions` may name only tools that are registered.
 *
 * ## Why this goes through the real initialize handshake
 *
 * `instructions` is the server-identity payload a client reads during `initialize`, and
 * an agent plans its whole session from it. It therefore has to be checked against the
 * SAME server a real client talks to, not against a string constant: the payload used to
 * advertise `list_workflow_actions`, `describe_workflow_action`, `run_workflow_action`
 * and `verify_artifact`, four names no `registerTool` call in this repository creates.
 * A client that believed that listing asked for tools that do not exist.
 *
 * The shared fixture `buildServer` in `test/fixtures/mcp-test-env.ts` cannot be used
 * here: it passes no `instructions`, so it has nothing to assert against. This file
 * builds the PRODUCTION factory `createWikiMcpServer`, connects it to an
 * `InMemoryTransport.createLinkedPair()` and reads both surfaces from a `Client`.
 *
 * ## The recommendation half
 *
 * `get_context_pack` carries the same promise one layer down: `suggestedActions[]` is
 * what an agent reads to decide its next call, so a suggestion that names anything
 * other than a registered tool (a binary, a CLI subcommand, a phantom) is the same
 * contract lie. The `get_context_pack` describe blocks drive the registered HANDLER
 * through `test/fixtures/mcp-test-env.ts` and compares every non-null `executable`
 * against the live `tools/list` — never against `buildContextPack` directly, which is
 * the bypass that let the deleted binary survive inside the tool payload.
 *
 * ## Why the constant is also asserted
 *
 * `test/mcp-server.test.ts` hand-maintains the registered names, which is the drift
 * shape this guard replaces. `WIKI_MCP_TOOL_NAMES` is the single declared source of
 * truth, and the last case pins it against the real `tools/list` in BOTH directions:
 * a tool added to the server but not to the constant, and a name declared but never
 * registered, each fail here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWikiMcpServer } from "../../packages/wiki/src/mcp/server.js";
import { WIKI_MCP_TOOL_NAMES } from "../../packages/wiki/src/mcp/tool-names.js";
import { buildServer, callTool, useMcpRoot } from "../fixtures/mcp-test-env.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/**
 * Names the instructions used to advertise and NO `registerTool` call ever created.
 *
 * Named one by one, and reported one by one, so a failure says which phantom survived.
 */
const PHANTOM_TOOL_NAMES = [
  "list_workflow_actions",
  "describe_workflow_action",
  "run_workflow_action",
  "verify_artifact",
] as const;

/** The tools the instructions must keep naming: the fix deletes adverts, not guidance. */
const NAMED_BY_INSTRUCTIONS = [
  "ingest_source",
  "compile_wiki",
  "query_wiki",
  "search_pages",
  "run_eval",
  "read_page",
  "lint_wiki",
  "wiki_status",
  "ingest_job_status",
  "ingest_jobs_list",
] as const;

/** Snake_case identifier shape: two or more lowercase segments, e.g. `read_page`. */
const SNAKE_CASE_TOKEN = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

/** The input fields one tool admits, as `tools/list` reports them. */
interface ToolInputShape {
  properties: string[];
  required: string[];
}

/** What a client reads from one server: inventory, instructions, and input shapes. */
interface AdvertisedSurface {
  registered: string[];
  instructions: string | undefined;
  shapes: Map<string, ToolInputShape>;
}

let root: string;

beforeEach(async () => {
  root = await scratchProjectRoot("advertised-tools-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Read `tools/list` and the initialize `instructions` from the production factory.
 *
 * @returns The registered tool names and the instructions payload, as a client sees them.
 */
async function readAdvertisedSurface(): Promise<AdvertisedSurface> {
  const server = createWikiMcpServer({ root, version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "advertised-tools-are-registered", version: "0" });
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return {
      registered: listed.tools.map((tool) => tool.name),
      instructions: client.getInstructions(),
      shapes: inputShapes(listed.tools),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Reduce each tool's JSON Schema to the two facts this guard compares against.
 *
 * @param tools - The `tools/list` result, as a client receives it.
 * @returns Every tool's admitted property names and its required ones, by tool name.
 */
function inputShapes(tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>): Map<string, ToolInputShape> {
  const shapes = new Map<string, ToolInputShape>();
  for (const tool of tools) {
    const schema = (tool.inputSchema ?? {}) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    shapes.set(tool.name, {
      properties: Object.keys(schema.properties ?? {}),
      required: schema.required ?? [],
    });
  }
  return shapes;
}

describe("MCP instructions advertise only registered tools", () => {
  it("returns non-empty instructions from the real initialize handshake", async () => {
    const { instructions } = await readAdvertisedSurface();

    expect(instructions).toBeTypeOf("string");
    expect(instructions?.trim()).not.toBe("");
  });

  it("names none of the four phantom workflow and artifact tools", async () => {
    const { instructions } = await readAdvertisedSurface();
    const text = instructions ?? "";
    const advertised = PHANTOM_TOOL_NAMES.filter((name) => text.includes(name));

    expect(
      advertised,
      `instructions advertise tools that no registerTool call creates: ${advertised.join(", ")}`,
    ).toEqual([]);
  });

  it("mentions no snake_case token that is not a registered tool", async () => {
    const { registered, instructions } = await readAdvertisedSurface();
    const tokens = [...new Set((instructions ?? "").match(SNAKE_CASE_TOKEN) ?? [])];
    const unknown = tokens.filter((token) => !registered.includes(token));

    expect(
      unknown,
      `instructions mention identifiers that are not registered tools: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

});

describe("MCP instructions keep naming the tools that carry the guidance", () => {
  it("keeps naming the registered tools that carry the guidance", async () => {
    const { registered, instructions } = await readAdvertisedSurface();
    const text = instructions ?? "";
    const dropped = NAMED_BY_INSTRUCTIONS.filter((name) => !text.includes(name));

    for (const name of NAMED_BY_INSTRUCTIONS) {
      expect(registered, `${name} must be registered for the instructions to name it`).toContain(name);
    }
    expect(dropped, `instructions stopped naming registered tools: ${dropped.join(", ")}`).toEqual([]);
    expect(text, "instructions must keep the no-API-key guidance").toContain("without an API key");
  });

  it("keeps WIKI_MCP_TOOL_NAMES equal to the registered set in both directions", async () => {
    const { registered } = await readAdvertisedSurface();
    const declared: string[] = [...WIKI_MCP_TOOL_NAMES];
    const missingFromConstant = registered.filter((name) => !declared.includes(name));
    const missingFromServer = declared.filter((name) => !registered.includes(name));

    expect(
      missingFromConstant,
      `registered tools absent from WIKI_MCP_TOOL_NAMES: ${missingFromConstant.join(", ")}`,
    ).toEqual([]);
    expect(
      missingFromServer,
      `WIKI_MCP_TOOL_NAMES entries that are not registered: ${missingFromServer.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * One `suggestedActions[]` entry exactly as the tool payload serializes it.
 *
 * Read as untrusted JSON on purpose: the guard must fail on the SHAPE the server
 * emits, not on the TypeScript type the builder claims to return.
 */
interface SuggestedActionPayload {
  command: string | null;
  reason: string;
  executable: { tool: string; input: Record<string, string> } | null;
}

/** One top-level pack warning exactly as the tool payload serializes it. */
interface PackWarningPayload {
  code: string;
  message: string;
}

/**
 * Assert no top-level pack warning carries command-shaped advice.
 *
 * Kept at module level so the `describe` block that owns the fixture stays inside the
 * repository's `max-lines-per-function` budget.
 *
 * @param warnings - The pack's `warnings[]`, read as untrusted JSON.
 */
function assertNoCommandShapedWarnings(warnings: PackWarningPayload[]): void {
  const commandShape = /llmwiki\s+[a-z][a-z0-9-]*/;
  const offenders = warnings.flatMap(({ code, message }) => {
    const match = message.match(commandShape)?.[0];
    return match ? [`${code}: ${match}`] : [];
  });

  // Non-vacuous: an empty warning list would satisfy the assertion below without reading
  // a single message. The empty stack warns about its missing embedding store, so at
  // least one message is always present here.
  expect(warnings.length, "no warnings were emitted, so this guard would prove nothing").toBeGreaterThan(0);
  expect(
    offenders,
    `warnings carry command-shaped advice naming a subcommand that does not exist: ${offenders.join(", ")}`,
  ).toEqual([]);
}

/** The live Stack and scratch project one `get_context_pack` describe block reads from. */
interface ContextPackFixture {
  /** Absolute project root the tool is called against. */
  root(): string;
  /** Whether the Stack provisioned; without it there is no payload to read. */
  reachable(): boolean;
  /** The id of the Stack this test provisioned. */
  stackId(): string;
}

/**
 * Install the Stack and scratch-root lifecycle for one `get_context_pack` describe block.
 *
 * Registered per block rather than per file so every block owns the Stack it reads: a
 * block sharing one could observe a row another block left behind.
 *
 * @returns Accessors for the project root, the Stack id, and its reachability.
 */
function useContextPackFixture(): ContextPackFixture {
  const contextRoot = useMcpRoot("advertised-recommendations");
  let stack: ProbeStack;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    stack = await createProbeStack("advertised-recommendations");
    savedEnv = installStackEnv(stack);
  });

  afterEach(async () => {
    process.env = savedEnv;
    await stack.harness.cleanup();
  });

  return {
    root: () => contextRoot.value,
    reachable: () => stack.harness.reachable,
    stackId: () => stack.harness.stackId,
  };
}

/**
 * Point the process at the Stack under test, returning the environment it replaced.
 *
 * @param stack - The provisioned Stack whose database and id become the live ones.
 * @returns The environment as it was, for the matching restore in `afterEach`.
 */
function installStackEnv(stack: ProbeStack): NodeJS.ProcessEnv {
  const saved = { ...process.env };
  process.env = { ...saved, ...stack.env() };
  return saved;
}

/**
 * Call the live `get_context_pack` handler and hand back the pack it serialised.
 *
 * @param fixture - The block's project root and Stack.
 * @param prompt - The prompt to ask under, which selects the suggestions emitted.
 * @returns The structured `result` payload, read as untrusted JSON.
 */
async function readContextPack(
  fixture: ContextPackFixture,
  prompt: string,
): Promise<Record<string, unknown>> {
  const result = await callTool(buildServer(fixture.root()), "get_context_pack", {
    prompt,
    stackId: fixture.stackId(),
  });
  return result.structuredContent?.result as Record<string, unknown>;
}

/**
 * Read the suggestion list back out of the live `get_context_pack` handler.
 *
 * The Stack is empty, so the pack describes the `fresh` state — the first state
 * every new project passes through and therefore the one an agent reads first.
 *
 * @param fixture - The block's project root and Stack.
 * @returns The live inventory, its input shapes, and the pack's suggestions.
 */
async function readSuggestions(fixture: ContextPackFixture): Promise<{
  registered: string[];
  shapes: Map<string, ToolInputShape>;
  actions: SuggestedActionPayload[];
}> {
  const { registered, shapes } = await readAdvertisedSurface();
  const pack = (await readContextPack(fixture, "an unregistered target probe")) as {
    suggestedActions: SuggestedActionPayload[];
  };
  return { registered, shapes, actions: pack.suggestedActions };
}

/**
 * Write one concept page so the pack's project state is `wiki-ready`.
 *
 * The state comes from `collectProjectState`, which counts PAGES ON DISK, and
 * `wiki-ready` is the state whose suggestion names the QUERY tool — the target whose
 * required field a command-shaped recommendation could not express.
 *
 * @param fixture - The block's project root.
 */
async function writeConceptPage(fixture: ContextPackFixture): Promise<void> {
  await writeFile(
    path.join(fixture.root(), "wiki", "concepts", "alpha.md"),
    "---\ntitle: Alpha\n---\n\nAlpha body.\n",
    "utf-8",
  );
}

describe("get_context_pack suggests only registered tools", () => {
  const fixture = useContextPackFixture();

  it("names only tools the live server registers, and labels each with that name", async () => {
    if (!fixture.reachable()) return;
    const { registered, actions } = await readSuggestions(fixture);

    expect(
      actions.length,
      "the fixture produced no suggestions, so this guard would prove nothing",
    ).toBeGreaterThan(0);
    const targets = actions.flatMap((a) => (a.executable ? [a.executable.tool] : []));
    const unknown = targets.filter((tool) => !registered.includes(tool));
    const mislabelled = actions
      .filter((a) => a.executable && a.command !== a.executable.tool)
      .map((a) => `${a.executable?.tool} labelled ${a.command}`);

    expect(unknown, `suggestions target unregistered tools: ${unknown.join(", ")}`).toEqual([]);
    expect(mislabelled, `suggestions are labelled by something else: ${mislabelled.join(", ")}`).toEqual([]);
  });
});

/**
 * Compare each suggestion's input against the live schema of the tool it targets.
 *
 * Both directions matter: a field the tool does not admit ([unknown]) is a call that
 * would be rejected, and a required field the suggestion omits ([missing]) is a call
 * that cannot be made at all. Each entry names the tool and the field, so a regression
 * reads as the exact misnaming rather than as a red expectation.
 *
 * @param actions - The pack's suggestions, read as untrusted JSON.
 * @param shapes - Every registered tool's admitted and required properties.
 * @returns One readable entry per misnamed field.
 */
function collectMisfields(
  actions: SuggestedActionPayload[],
  shapes: Map<string, ToolInputShape>,
): string[] {
  const misfields: string[] = [];
  for (const { executable } of actions) {
    if (!executable) continue;
    const shape = shapes.get(executable.tool);
    const fields = Object.keys(executable.input);
    for (const field of fields) {
      if (!shape?.properties.includes(field)) misfields.push(`${executable.tool}.${field} [unknown]`);
    }
    for (const field of shape?.required ?? []) {
      if (!fields.includes(field)) misfields.push(`${executable.tool}.${field} [missing]`);
    }
  }
  return misfields;
}

describe("get_context_pack spells the input shape its target tool takes", () => {
  const fixture = useContextPackFixture();

  it("passes exactly the input fields its target tool takes", async () => {
    if (!fixture.reachable()) return;
    await writeConceptPage(fixture);
    const { shapes, actions } = await readSuggestions(fixture);
    const tools = actions.map((a) => a.executable?.tool);
    const misfields = collectMisfields(actions, shapes);

    // Non-vacuous: the wiki-ready pack must actually suggest the query call, whose
    // required field is `question` — the field a command-shaped recommendation cannot
    // express, and the one most easily misnamed.
    expect(tools).toContain("query_wiki");
    expect(
      misfields,
      `suggestions misname the fields their tool takes: ${misfields.join(", ")}`,
    ).toEqual([]);
  });
});

describe("get_context_pack carries no command-shaped advice in its warnings", () => {
  const fixture = useContextPackFixture();

  /**
   * The same promise, one field over: `warnings[].message` is prose an agent acts on.
   *
   * `suggestedActions` was the surface the guard above pins, but the top-level
   * `warnings[]` payload is read by the same client and carried command-shaped advice of
   * its own ("call `llmwiki compile`", "run `llmwiki review list`"). Nothing asserted it,
   * so the repair of those strings had no test to keep them repaired. Every warning is
   * written by `buildTopLevelWarnings` and reports a `code`, so a regression names both
   * the code and the offending match instead of just failing a regex somewhere.
   *
   * Written AFTER that repair landed: it pins the class from here on, and it had no RED
   * failure of its own.
   */
  it("carries no command-shaped advice in the pack's warnings", async () => {
    if (!fixture.reachable()) return;
    const pack = (await readContextPack(fixture, "a warnings probe")) as {
      warnings: PackWarningPayload[];
    };

    assertNoCommandShapedWarnings(pack.warnings);
  });
});
