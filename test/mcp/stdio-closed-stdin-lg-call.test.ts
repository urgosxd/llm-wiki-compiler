/**
 * @file test/mcp/stdio-closed-stdin-lg-call.test.ts
 * @description A PIPED one-shot `serve` session — the shape `docker run -i` and this
 * repository's own CI container check use — must answer a graph tool whose request arrived in the
 * same stdin burst that ended it.
 *
 * ## The defect this pins
 *
 * `serve` answers the graph tools from a loopback listener it binds for its own session, and it
 * retired that listener on stdin `end`. A client that writes `initialize`,
 * `notifications/initialized` and `tools/call query_stack` in one burst and then closes stdin is
 * answered by a request handler that has NOT yet reached the listener when `end` fires: the JSON-RPC
 * dispatch is asynchronous, `end` is not. The listener was torn down under the in-flight call, so
 * the tool answered `fetch failed` — a dead socket, not a graph route. The graph tools are HTTP
 * clients, so "the listener must outlive the session's own requests" is the whole requirement.
 *
 * ## Why the session is written by hand
 *
 * The subject is the framing a piped client produces: three newline-delimited JSON lines on ONE
 * stdin that closes immediately after them. `StdioClientTransport` holds stdin open until the
 * client closes, which is the shape that always worked, so the raw bytes are written here.
 *
 * ## What the call is allowed to answer with no database
 *
 * The child declares no usable database, so a graph route that reaches Postgres fails there. The
 * honest outcome is the graph's OWN envelope — `AKS server returned <status>: <body>` — which only an
 * HTTP response produces. Asserting a success would assert something this deployment cannot produce;
 * what is asserted is that the in-process graph ROUTE was reached at all, and that the process still
 * leaves promptly instead of hanging on the listener it kept alive for that one call.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { launch, type Running } from "../fixtures/launcher-harness.js";
import { useMcpRoot } from "../fixtures/mcp-test-env.js";
import { testDotenvEnv } from "../fixtures/test-dotenv.js";

/** Bound on the wait for the piped child to leave; past it, the session is wedged, not slow. */
const EXIT_BUDGET_MS = 15_000;

/** The same closed port as a PostgreSQL DSN, so the graph pool cannot reach a real database. */
const CLOSED_DATABASE_URL = "postgresql://aks:aks@127.0.0.1:1/aks";

/** The three messages a faithful piped client writes, in the order a session requires. */
const PIPED_SESSION = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "piped-probe", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "query_stack", arguments: { query: "what is a stack", stackId: "00000000-0000-0000-0000-000000000000" } },
  },
] as const;

/** The id of the reply this file asserts on: the graph TOOL CALL, not the handshake. */
const CALL_ID = 2;

/** One JSON-RPC frame, as far as this file reads it. */
interface RpcReply {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly type: string; readonly text?: string }[] };
}

/** One finished piped session: how it ended, what it said, and how long the teardown took. */
interface PipedOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly teardownMs: number;
}

/**
 * The child's environment: the committed corpus, then "no database, no external graph API".
 *
 * `AKS_BASE_URL` is deleted because the subject is what `serve` does with the listener it binds
 * itself; `AKS_DATABASE_URL` is pinned blank (not deleted, which `dotenv` would refill) so the graph
 * route fails on Postgres instead of reaching one.
 */
function serveEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...testDotenvEnv(),
    AKS_DATABASE_URL: "",
    AKS_STACK_ID: "",
    DATABASE_URL: CLOSED_DATABASE_URL,
  };
  delete env["AKS_BASE_URL"];
  return env;
}

/** Wait for the piped child to be gone, and SIGTERM it if it outlives the budget. */
async function settleWithin(running: Running): Promise<{ code: number | null }> {
  const settled = await Promise.race([
    running.exited,
    sleep(EXIT_BUDGET_MS).then(() => "timeout" as const),
  ]);
  if (settled === "timeout") {
    running.terminate();
    throw new Error(
      `the piped session did not exit within ${EXIT_BUDGET_MS}ms of its stdin closing; ` +
        `stdout: ${running.stdout()}; stderr: ${running.stderr()}`,
    );
  }
  return settled;
}

/**
 * Run one piped session: the three frames in a single burst, stdin closed immediately after.
 *
 * @param projectRoot - The root the child serves.
 * @returns How it ended, what it wrote, and the wall-clock teardown.
 */
async function pipedSession(projectRoot: string): Promise<PipedOutcome> {
  const running = launch(["serve", "--root", projectRoot], projectRoot, serveEnvironment());
  const start = Date.now();
  for (const frame of PIPED_SESSION) running.send(JSON.stringify(frame));
  running.closeStdin();
  // `settleWithin` SIGTERMs the child itself, so this session owns no surviving process.
  const { code } = await settleWithin(running);
  return { code, stdout: running.stdout(), stderr: running.stderr(), teardownMs: Date.now() - start };
}

/** Every non-empty stdout line, decoded: in `serve` mode the stream is nothing but JSON-RPC. */
function replies(outcome: PipedOutcome): RpcReply[] {
  return outcome.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as RpcReply;
      } catch {
        throw new Error(`stdout carried a non-JSON-RPC line: ${JSON.stringify(line)}`);
      }
    });
}

/** The text blocks of a tool result, joined the way a client renders them. */
function resultText(reply: RpcReply | undefined): string {
  return (reply?.result?.content ?? []).map((block) => block.text ?? "").join("");
}

describe("a piped serve session answers the graph call it ended with", () => {
  const root = useMcpRoot("piped-serve-");

  it("answers query_stack from the live listener instead of a dead socket", async () => {
    const outcome = await pipedSession(root.value);
    const call = replies(outcome).find((reply) => reply.id === CALL_ID);
    const text = resultText(call);
    expect(call, `no reply to the tool call; stderr: ${outcome.stderr}`).toBeDefined();
    expect(text, `the in-flight call must not die at a socket; stderr: ${outcome.stderr}`).not.toMatch(
      /fetch failed/i,
    );
    // Only an HTTP RESPONSE produces this envelope, so it is the reachability proof.
    expect(text).toMatch(/^AKS server returned \d{3}: /);
  }, 60_000);

  it("still exits 0 promptly once that call is answered", async () => {
    const outcome = await pipedSession(root.value);
    expect(outcome.code, `stderr: ${outcome.stderr}`).toBe(0);
    expect(outcome.teardownMs).toBeLessThan(EXIT_BUDGET_MS);
  }, 60_000);
});
