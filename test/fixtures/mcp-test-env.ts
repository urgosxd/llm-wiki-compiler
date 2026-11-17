/**
 * Shared MCP-server test fixture used by `test/mcp-server.test.ts`
 * (the broad tool/resource suite) and `test/mcp-context.test.ts`
 * (the Slice 5 `get_context_pack` slice). Both files used to inline
 * the same temp-root lifecycle, server bootstrap, internal-handler
 * caller, and workspace snapshotter; fallow flagged the duplication
 * after the Slice 5 split.
 *
 * Exposed surface:
 *   - `useMcpRoot(prefix)` registers beforeEach/afterEach and
 *     returns a `{ value: string }` so each test reads the current
 *     temp root via `root.value`.
 *   - `connectMcpClient(root)` spawns the real stdio server from the
 *     surviving executable (`dist/api.js serve --root <root>`) over a
 *     `StdioClientTransport`, so the JSON-RPC framing is exercised for real.
 *     The child's MODE is decided here, once (see {@link childEnv}).
 *   - `buildServer(root)` returns a fresh `McpServer` with the wiki tools,
 *     the resources, and the OKF export tool — the same inventory the
 *     production factory serves.
 *   - `callTool(server, name, args)` invokes a registered tool's
 *     handler directly (no stdio transport) and returns its raw
 *     `{ content, structuredContent }` envelope.
 *   - `snapshotWorkspace(root)` walks the temp root and returns the
 *     sorted relative-path list so tests can assert "this tool did
 *     not mutate the workspace".
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testDotenvEnv } from "./test-dotenv.js";
import {
  AKS_DATABASE_URL_ENV_VAR,
  isDatabaseConfigured,
} from "../../packages/wiki/src/dimensions/activation.js";
import { registerWikiTools } from "../../packages/wiki/src/mcp/tools.js";
import { registerOkfTools } from "../../packages/wiki/src/mcp/okf-tools.js";
import { registerWikiResources } from "../../packages/wiki/src/mcp/resources.js";

/**
 * The surviving executable, whose `serve` subcommand IS the stdio MCP server.
 *
 * Spelled here rather than imported from `fixtures/run-cli.ts`: that helper's
 * `CLI` names the retired CLI bundle, and every other spawner still legitimately
 * uses it for the CLI-only commands. `dist/api.js` dispatches `serve` to the same
 * `startMCPServer` the CLI's `serve` command called, with the same `--root`
 * handling, so the JSON-RPC surface under test is unchanged.
 */
const MCP_ENTRY = path.resolve("dist/api.js");

/** Live container for the current test's temp root path. */
export interface McpRootHandle {
  value: string;
}

/**
 * Vitest composable that creates + tears down a per-test temp
 * workspace with the directory layout the MCP server expects.
 * `prefix` lets each test file have an identifiable temp-dir name.
 */
export function useMcpRoot(prefix: string): McpRootHandle {
  const handle: McpRootHandle = { value: "" };
  beforeEach(async () => {
    handle.value = path.join(
      os.tmpdir(),
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(path.join(handle.value, "wiki/concepts"), { recursive: true });
    await mkdir(path.join(handle.value, "wiki/queries"), { recursive: true });
    await mkdir(path.join(handle.value, "sources"), { recursive: true });
    await mkdir(path.join(handle.value, ".llmwiki"), { recursive: true });
  });
  afterEach(async () => {
    await rm(handle.value, { recursive: true, force: true });
  });
  return handle;
}

/** A connected SDK Client + its transport, spawned over real stdio. */
export interface McpClientHandle {
  client: Client;
  transport: StdioClientTransport;
}

/**
 * The spelling of "no database configured" this fixture pins into a spawned child.
 *
 * PRESENT and BLANK, never deleted — the same declaration `test/fixtures/file-mode.ts`
 * makes for the parent process and `test/fixtures/run-cli-server.ts` makes for its own
 * child, and for the same measured reason: `packages/api/src/load-environment.ts` loads
 * `dotenv/config` before anything reads the environment, dotenv does not overwrite a key
 * that already exists, so a DELETED variable is refilled from the corpus
 * {@link testDotenvEnv} points at — and that corpus names a database. A blank value
 * survives the load and reads as "not configured" to every production reader, which all
 * ask `(env[VAR] ?? "").trim() !== ""`.
 *
 * Measured, not assumed: `test/parity-default.test.ts` declares file mode with
 * `useFileMode()`, whose hook DELETES the variable, so the child used to inherit an
 * absent key, refill it from the corpus and run against a database it was never given —
 * `serve` then refused every read with "AKS_DATABASE_URL is configured, so this run must
 * have a Stack, but no database handle was supplied to resolve it".
 */
const NO_DATABASE = "";

/**
 * The child's environment, with the run's mode carried across the process boundary.
 *
 * A mode declaration cannot cross a boundary by itself, so this is the one place that
 * decides what a spawned MCP server sees, and it asks the SAME question production asks
 * ({@link isDatabaseConfigured}) instead of deriving the mode a second way:
 *
 *   1. the caller named the variable itself in `envOverrides` — including pinning it
 *      blank — so the answer is the caller's, untouched;
 *   2. the parent has a database configured, so the child inherits that database: the
 *      suite seeded rows on it deliberately and its tools are called with a `stackId`;
 *   3. otherwise the parent is the named file mode, and the child is made the same mode
 *      by pinning {@link NO_DATABASE}.
 *
 * Step 2 is the inherited case, and it is not a guess: a suite that never configures a
 * database cannot reach a row-backed assertion through a spawned child, and a suite that
 * does wants that database in the child. So the file mode is what crosses the boundary
 * BY DEFAULT, and a database-backed child is what a suite gets by asking — either by
 * leaving its own worker database in place (`test/mcp-stdio.test.ts` and
 * `test/okf-mcp-stdio.test.ts`, which seed a Stack and pass `stackId` per call) or by
 * handing a DSN through `envOverrides`, the same explicit request `childEnv` in
 * `test/fixtures/run-cli-server.ts` documents.
 *
 * @param envOverrides - Variables the caller sets explicitly; they win over both the
 *   inherited environment and the corpus.
 * @returns The environment to hand the child process.
 */
function childEnv(envOverrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...testDotenvEnv(), ...envOverrides };
  if (AKS_DATABASE_URL_ENV_VAR in envOverrides) return env;
  if (isDatabaseConfigured(process.env)) return env;
  env[AKS_DATABASE_URL_ENV_VAR] = NO_DATABASE;
  return env;
}

/**
 * Spawn the launcher's `serve` subcommand over stdio and connect an SDK Client
 * through the full JSON-RPC stack. Shared by every MCP stdio integration test.
 *
 * The child runs file-backed unless its suite declares a database (see {@link childEnv});
 * a suite that needs rows passes a DSN in `envOverrides`.
 *
 * @param root - Project root the server is bound to.
 * @param envOverrides - Variables the caller sets explicitly, including a DSN that asks
 *   for a database-backed child.
 * @returns The connected client and its transport.
 */
export async function connectMcpClient(
  root: string,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<McpClientHandle> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_ENTRY, "serve", "--root", root],
    stderr: "ignore",
    cwd: path.resolve("."),
    // The SDK inherits only a handful of variables, so the corpus override has to be
    // handed over explicitly or the subprocess reads the operator's real `.env`.
    env: childEnv(envOverrides),
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Parse the JSON payload out of a tool response's text content blocks. Shared by
 * the stdio integration tests so the text-join + JSON.parse lives in one place.
 *
 * @param result - A `tools/call` response from an SDK Client.
 * @returns The decoded JSON payload, typed by the caller.
 */
export function parseToolPayload<T>(result: CallToolResult): T {
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return JSON.parse(text) as T;
}

/**
 * Build a fresh McpServer with the wiki tools, the resources and the OKF tool.
 *
 * The OKF export tool (`export_okf`) is registered here rather than left out: a
 * `tools/list` walk over this fixture is what most suites assert the tool contract
 * against, and omitting it made every such walk blind to exactly the tool a lost
 * required Stack would break first. The inventory therefore matches
 * `createWikiMcpServer`, and `test/mcp/tools-list-requires-stack.test.ts` pins that
 * parity so the two cannot drift apart again.
 *
 * Registration only: the OKF handlers still reach their seams when CALLED, so a
 * suite that drives an OKF tool through here needs the Stack rows those seams
 * read — which is why the OKF call coverage lives in
 * `test/mcp/tools-required-stack-okf-ingest.test.ts`.
 */
export function buildServer(root: string): McpServer {
  const server = new McpServer({ name: "llmwiki-test", version: "0.0.0" });
  registerWikiTools(server, root);
  registerOkfTools(server, root);
  registerWikiResources(server, root);
  return server;
}

/** MCP envelope shape returned by every registered tool handler. */
export interface McpToolEnvelope {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { result: unknown };
  /** Present + `true` when the handler reports a clean tool-level error. */
  isError?: boolean;
}

/**
 * Invoke a registered tool's handler directly. Mirrors what an MCP
 * client would do over stdio without paying the transport setup cost.
 */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolEnvelope> {
  const tools = (server as unknown as {
    _registeredTools: Record<
      string,
      { handler: (a: Record<string, unknown>) => Promise<unknown> }
    >;
  })._registeredTools;
  const tool = tools[name];
  return tool.handler(args) as Promise<McpToolEnvelope>;
}

/**
 * Snapshot every file under `rootDir` by relative path so tests can
 * assert "this tool did not mutate the workspace" via a round-trip
 * equality check.
 */
export async function snapshotWorkspace(rootDir: string): Promise<string[]> {
  const entries: string[] = [];
  await walkInto(rootDir, rootDir, entries);
  return entries.sort();
}

/** Recursive walker used by {@link snapshotWorkspace}. */
async function walkInto(rootDir: string, dir: string, out: string[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) await walkInto(rootDir, full, out);
    else out.push(path.relative(rootDir, full));
  }
}
