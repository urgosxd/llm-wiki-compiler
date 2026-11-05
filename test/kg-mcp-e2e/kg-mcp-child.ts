/**
 * @file test/kg-mcp-e2e/kg-mcp-child.ts
 * @description The real KG MCP server, driven by a real MCP client over stdio.
 *
 * ## What is real here
 *
 * `StdioClientTransport` spawns a child process and speaks the protocol over its
 * stdin/stdout; `Client.connect` is the `initialize` handshake, and
 * `client.callTool` is a `tools/call` request. Nothing is linked in memory and
 * nothing shares this process's heap, so a tool call in the probe crosses:
 *
 *   test process → child stdin → MCP server → real HTTP (through the counting
 *   proxy) → real KG API → real Postgres
 *
 * ## Why the child runs `runStdio()` through `--eval`
 *
 * `runStdio()` is the entry S1 names, and it is deliberately not invoked on import
 * (its own module says so). So the child imports the built `dist/mcp.js` and calls
 * `runStdio()` — the same two steps a launcher performs, with no launcher to
 * maintain. `main()` is one line shorter but catches startup failures and reports
 * them on stderr, which would hide a broken entry from the client; calling
 * `runStdio()` lets a rejected connect surface here instead.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Repository root, so the child is spawned by absolute path. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The built MCP server module: `dist/mcp/server.js` exports `runStdio`.
 *
 * NOT `dist/mcp.js`: that module re-exports the public surface — `createMcpServer`,
 * the registry, the formatters — and deliberately omits `runStdio`, so importing it
 * and calling `runStdio()` fails with "runStdio is not a function". The entry S1
 * names lives one level down, in the module that binds stdio.
 */
export const MCP_ENTRY = `${REPO_ROOT}/packages/llmwiki-kg/ts/dist/mcp/server.js`;

/** How long the handshake may take before it is called a failure. */
const CONNECT_TIMEOUT_MS = 30_000;

/** How long the child is given to leave after its stdio is closed. */
const EXIT_TIMEOUT_MS = 10_000;

/** A connected MCP client and the way to end the session. */
export interface McpProbe {
  /** `tools/list` over the handshake. */
  readonly listTools: () => Promise<ListToolsResult>;
  /** `tools/call` over the handshake. */
  readonly call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** The last lines the child printed to stderr, for a failing assertion. */
  readonly log: () => string;
  /** The child's pid, so the teardown can prove it is gone. */
  readonly pid: number | null;
  /** Close the session, then confirm the child is no longer running. */
  readonly stop: () => Promise<void>;
}

/** The text of a tool result: the only content block these tools answer with. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** The program the child runs: import the built entry, then start it over stdio. */
function runStdioProgram(): string {
  return `const { runStdio } = await import(${JSON.stringify(MCP_ENTRY)}); await runStdio();`;
}

/** Is `pid` still a live process? `kill(pid, 0)` asks without signalling. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `pid` is no longer running; `false` if it outlived the budget. */
async function waitUntilGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(50);
  }
  return !processAlive(pid);
}

/** Reject `promise` if it has not settled within `ms`, naming what timed out. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const timedOut = Symbol("timeout");
  const result = await Promise.race([promise, sleep(ms).then(() => timedOut as const)]);
  if (result === timedOut) throw new Error(`${what} did not complete within ${String(ms)} ms`);
  return result as T;
}

/**
 * Spawn the KG MCP server and complete a protocol handshake with it.
 *
 * @param baseUrl - The counting proxy's base URL, which the child sees as `AKS_BASE_URL`.
 * @returns The connected client; `stop()` ends the session and its child.
 */
export async function startKgMcp(baseUrl: string): Promise<McpProbe> {
  const stderrLines: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", runStdioProgram()],
    // Nothing inherited that could silently supply a different endpoint or key:
    // the child's whole environment is the four values below.
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      AKS_BASE_URL: baseUrl,
      AKS_API_KEY: "",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk.toString("utf-8"));
    while (stderrLines.length > 40) stderrLines.shift();
  });

  const client = new Client({ name: "kg-mcp-e2e-probe", version: "0.0.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "the MCP handshake");
  } catch (error) {
    throw new Error(
      `the KG MCP server never completed a handshake (entry ${MCP_ENTRY}): ` +
        `${(error as Error).message}\nchild stderr:\n${stderrLines.join("")}`,
    );
  }
  const pid = transport.pid;

  return {
    listTools: () => client.listTools(),
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    log: () => stderrLines.join(""),
    pid,
    stop: async () => {
      // The transport ends the child's stdin, then SIGTERMs and finally kills it.
      await client.close().catch(() => undefined);
      if (pid !== null && !(await waitUntilGone(pid))) {
        throw new Error(`the MCP child (pid ${String(pid)}) outlived the teardown`);
      }
    },
  };
}
