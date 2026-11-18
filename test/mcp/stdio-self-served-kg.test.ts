/**
 * @file test/mcp/stdio-self-served-kg.test.ts
 * @description `serve` — the mode `docker/entry.sh` starts by default — must answer the graph
 * tools itself, without any external service, and without writing one byte of non-protocol
 * data to the stream its client is reading.
 *
 * ## The defect this pins
 *
 * The union advertises three graph tools that are HTTP clients of a graph API. In `host` mode
 * that API is the listener the same process binds, so `selfServedKgBaseUrl` points them at it.
 * In `serve` mode nothing was bound and no `kgBaseUrl` was passed, so they fell back to the MCP
 * config's own default (`http://localhost:8000`) and every call answered `fetch failed` — three
 * advertised tools the shipped image could not honour. `tools/list` correctness was never the
 * requirement; reachability is. So the case that matters CALLS `query_stack` and asserts the
 * failure came from a graph route that answered, not from a dead socket.
 *
 * ## Why the subject is the spawned artifact
 *
 * The claim is about the mode the container starts, so it is measured across a real process
 * boundary: `node dist/api.js serve --root <dir>`, driven with newline-delimited JSON-RPC on
 * stdin/stdout — the same framing `StdioClientTransport` uses, written by hand here because the
 * raw stdout BYTES are the subject of one case and the SDK transport does not expose them.
 *
 * ## Why stdout purity is a case and not a comment
 *
 * In `serve` mode stdout IS the protocol channel. A readiness banner, a log line or a stray
 * `console.log` corrupts the stream and breaks every client, so every non-empty stdout line this
 * file captures is parsed as JSON-RPC. A working handshake is necessary but not sufficient: a
 * server can handshake cleanly and still emit one banner at bind time.
 *
 * ## What the graph call is allowed to answer with no database
 *
 * The child declares no usable database (`AKS_DATABASE_URL` blank and `DATABASE_URL` pinned to a
 * closed port), so a graph route that reaches Postgres fails there. The honest outcome is
 * therefore the graph's OWN error envelope — `AKS server returned <status>: <body>` — which is
 * only produced from an HTTP response. Asserting a success would be asserting something this
 * deployment cannot produce.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { launch, waitForReady, type Running } from "../fixtures/launcher-harness.js";
import { useMcpRoot } from "../fixtures/mcp-test-env.js";
import { testDotenvEnv } from "../fixtures/test-dotenv.js";
import { EXPECTED_UNION_TOOLS } from "./union-inventory.js";

/**
 * A loopback port nothing listens on: a reserved, unbindable number, so "the connection is
 * refused" is a property of the value rather than of whatever else this machine is running.
 */
const CLOSED_BASE_URL = "http://127.0.0.1:1";

/** The same closed port as a PostgreSQL DSN, so the graph's pool cannot reach a real database. */
const CLOSED_DATABASE_URL = "postgresql://aks:aks@127.0.0.1:1/aks";

/**
 * The line `serve` writes to STDERR once its self-served graph listener is bound.
 *
 * stderr is the only channel a stdio server may log on, and this line is what makes the
 * ephemeral port observable from outside — which is how the loopback-only and minimal-surface
 * claims below are measured instead of reasoned about.
 */
const SELF_SERVED_LINE = /^\[kg\] serving the graph tools from (http:\/\/\S+)$/m;

/** Bound on the wait for one JSON-RPC reply, and on the wait for a stopped child to leave. */
const REPLY_DEADLINE_MS = 30_000;
const EXIT_BUDGET_MS = 10_000;

/** How often the captured stdout is re-read while waiting for a reply. */
const POLL_MS = 20;

/** One JSON-RPC message, as far as this file reads it. */
interface RpcReply {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly error?: { readonly code: number; readonly message: string };
  readonly result?: {
    readonly serverInfo?: { readonly name?: string };
    readonly tools?: readonly { readonly name: string }[];
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
  };
}

/**
 * The child's environment: the committed corpus, then "no database configured".
 *
 * `AKS_BASE_URL` is DELETED unless a case names one, because the whole subject is what `serve`
 * does when no external graph API is configured. Deleting it is safe here — the corpus does not
 * define it, so `dotenv` cannot refill it — while `AKS_DATABASE_URL` is pinned blank, exactly as
 * the other launcher suites do, because the corpus DOES name a database.
 *
 * @param overrides - Variables this case sets explicitly; they win over everything above.
 * @returns The environment to hand the spawned `serve` child.
 */
function serveEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...testDotenvEnv(),
    AKS_DATABASE_URL: "",
    AKS_STACK_ID: "",
    DATABASE_URL: CLOSED_DATABASE_URL,
  };
  delete env["AKS_BASE_URL"];
  return { ...env, ...overrides };
}

/** The complete, newline-terminated lines the child has written to stdout so far. */
function completeLines(running: Running): string[] {
  return running.stdout().split("\n").slice(0, -1).filter((line) => line.trim() !== "");
}

/**
 * Wait for the reply whose `id` is `id`, polling the captured bytes.
 *
 * @param running - The child under test.
 * @param id - The request id this case is waiting for.
 * @returns The decoded reply.
 */
async function replyTo(running: Running, id: number): Promise<RpcReply> {
  const deadline = Date.now() + REPLY_DEADLINE_MS;
  while (Date.now() < deadline) {
    for (const line of completeLines(running)) {
      const parsed = JSON.parse(line) as RpcReply;
      if (parsed.id === id) return parsed;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `no JSON-RPC reply to id ${id} within ${REPLY_DEADLINE_MS}ms; ` +
      `stdout: ${running.stdout()}; stderr: ${running.stderr()}`,
  );
}

/** Send one request and wait for its reply. */
async function request(
  running: Running,
  id: number,
  method: string,
  params: unknown,
): Promise<RpcReply> {
  running.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return replyTo(running, id);
}

/**
 * Complete the MCP handshake every client opens with.
 *
 * `initialize` must answer before any other request is legal, so this is the precondition of
 * every case here and not an extra assertion.
 */
async function openSession(running: Running): Promise<void> {
  const reply = await request(running, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "stdio-self-served-kg", version: "1" },
  });
  expect(reply.error, "initialize must not answer with a JSON-RPC error").toBeUndefined();
  expect(reply.result?.serverInfo?.name).toBeTruthy();
  running.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
}

/** The text blocks of a tool result, joined the way a client renders them. */
function resultText(reply: RpcReply): string {
  return (reply.result?.content ?? []).map((block) => block.text ?? "").join("");
}

/** Wait for a stopped child to be gone, and SIGTERM it if it outlives the budget. */
async function settleOrKill(running: Running): Promise<void> {
  const settled = await Promise.race([
    running.exited.then(() => "exited" as const),
    sleep(EXIT_BUDGET_MS).then(() => "timeout" as const),
  ]);
  if (settled === "timeout") running.terminate();
}

/** Stop a `serve` child the way a client does — end stdin. */
async function stop(running: Running): Promise<void> {
  running.closeStdin();
  await settleOrKill(running);
}

/** Stop a `host` child the way `docker stop` does — SIGTERM. */
async function stopHost(running: Running): Promise<void> {
  running.terminate();
  await settleOrKill(running);
}

/** Call one tool over the session and return the text the client would render. */
async function callTool(
  running: Running,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const reply = await request(running, id, "tools/call", { name, arguments: args });
  expect(reply.error, `${name} must be a registered tool, not a protocol error`).toBeUndefined();
  return resultText(reply);
}

/**
 * Run one case against a child of its own, and stop it whatever happens.
 *
 * Each case owns a child because the subject IS the child's process shape: the listener it binds
 * and the bytes it writes both belong to that process and to nothing shared.
 *
 * @param projectRoot - The root the child serves.
 * @param env - The child's environment.
 * @param body - What the case asserts, once the child is up.
 */
async function withServeChild(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  body: (running: Running) => Promise<void>,
): Promise<void> {
  const running = launch(["serve", "--root", projectRoot], projectRoot, env);
  try {
    await openSession(running);
    await body(running);
  } finally {
    await stop(running);
  }
}

/** S2/S3: the inventory the container's default mode must advertise. */
async function expectUnionInventory(projectRoot: string): Promise<void> {
  await withServeChild(projectRoot, serveEnvironment(), async (running) => {
    const names = ((await request(running, 2, "tools/list", {})).result?.tools ?? [])
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual(EXPECTED_UNION_TOOLS);
    expect(names).toHaveLength(EXPECTED_UNION_TOOLS.length);
  });
}

/** S2/S10: the graph call must reach a graph route that ANSWERS, not a dead port. */
async function expectInProcessGraphAnswer(projectRoot: string): Promise<void> {
  await withServeChild(projectRoot, serveEnvironment(), async (running) => {
    const text = await callTool(running, 3, "query_stack", {
      query: "what is a stack",
      stackId: randomUUID(),
    });
    expect(text, `the graph call must not die at a socket; stderr: ${running.stderr()}`).not.toMatch(
      /fetch failed/i,
    );
    // Measured with no usable database: `AKS server returned 500: Internal Server Error`, which a
    // graph tool reports as PLAIN text and not as a tool-level error (the KG's ported behaviour for
    // a non-200). Only an HTTP RESPONSE produces this prefix, so it is a reachability proof.
    expect(text).toMatch(/^AKS server returned \d{3}: /);
    expectSelfServedAddressIsPrivate(running);
    await expectWriteRoutesUnreachable(running);
  });
}

/** S7: the listener is loopback, ephemeral, and announced on stderr only. */
function expectSelfServedAddressIsPrivate(running: Running): void {
  const bound = running.stderr().match(SELF_SERVED_LINE)?.[1] ?? "";
  expect(bound, "the listener must be announced on stderr, on loopback").toMatch(
    /^http:\/\/127\.0\.0\.1:\d+$/,
  );
  expect(new URL(bound).port, "the port must be ephemeral, not a published one").not.toBe("0");
}

/** The listener serves the prefix the tools call, and not the graph app's write routes. */
async function expectWriteRoutesUnreachable(running: Running): Promise<void> {
  const bound = running.stderr().match(SELF_SERVED_LINE)?.[1] ?? "";
  const refused = await fetch(`${bound}/documents`, { method: "POST", body: "{}" });
  expect(refused.status, `POST ${bound}/documents must not reach the graph write routes`).toBe(404);
}

/** Stdout purity: every non-empty line the child wrote must be a JSON-RPC frame. */
async function expectPristineStdout(projectRoot: string): Promise<void> {
  await withServeChild(projectRoot, serveEnvironment(), async (running) => {
    await request(running, 2, "tools/list", {});
    await callTool(running, 3, "get_entities", { stackId: randomUUID() });
    const frames = completeLines(running);
    expect(frames.length, "the handshake, the listing and the call must have answered").toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      let parsed: RpcReply;
      try {
        parsed = JSON.parse(frame) as RpcReply;
      } catch {
        throw new Error(`stdout carried a non-JSON-RPC line: ${JSON.stringify(frame)}`);
      }
      expect(parsed.jsonrpc, `every stdout line must be a JSON-RPC frame: ${frame}`).toBe("2.0");
    }
  });
}

/** Requirement 2: a configured graph API wins and NOTHING is bound. */
async function expectConfiguredBaseUrlWins(projectRoot: string): Promise<void> {
  await withServeChild(projectRoot, serveEnvironment({ AKS_BASE_URL: CLOSED_BASE_URL }), async (running) => {
    const text = await callTool(running, 3, "query_stack", {
      query: "what is a stack",
      stackId: randomUUID(),
    });
    // The external API is the one the operator named, and it is unreachable: a configured base URL
    // must not be silently replaced by a listener this process opened.
    expect(text).toMatch(/fetch failed/i);
    expect(text).not.toMatch(/^AKS server returned /);
    expect(running.stderr()).not.toMatch(SELF_SERVED_LINE);
  });
}

/** Post one JSON-RPC message to `/mcp` and decode an SSE-framed or plain JSON reply. */
async function postRpc(base: string, body: unknown): Promise<RpcReply> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return JSON.parse(raw.match(/^data: (.+)$/m)?.[1] ?? raw) as RpcReply;
}

/**
 * PRESERVE: `host` mode still answers a graph tool from the listener it binds.
 *
 * The two transports share one module, so a change made for `serve` must leave `host`'s own
 * self-served graph path exactly as it was. With no usable database the call fails INSIDE the
 * graph route, which is what proves it arrived there rather than at a dead port.
 */
async function expectHostSelfServedGraphAnswer(projectRoot: string): Promise<void> {
  const child = launch(["host", "--port", "0"], projectRoot, serveEnvironment());
  try {
    const base = await waitForReady(child);
    await postRpc(base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    });
    const reply = await postRpc(base, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_entities", arguments: { stackId: randomUUID() } },
    });
    expect(resultText(reply)).toMatch(/^AKS server returned \d{3}: /);
  } finally {
    await stopHost(child);
  }
}

describe("serve serves the graph tools itself", () => {
  const root = useMcpRoot("stdio-self-served-kg-");

  it("advertises the 17-name union with no external graph API configured", async () => {
    await expectUnionInventory(root.value);
  }, 60_000);

  it("answers query_stack from a loopback listener in this same process", async () => {
    await expectInProcessGraphAnswer(root.value);
  }, 60_000);

  it("writes nothing to stdout that is not JSON-RPC", async () => {
    await expectPristineStdout(root.value);
  }, 60_000);

  it("keeps an operator's AKS_BASE_URL authoritative and binds nothing", async () => {
    await expectConfiguredBaseUrlWins(root.value);
  }, 60_000);

  it("still answers a graph tool from the listener host mode binds", async () => {
    await expectHostSelfServedGraphAnswer(root.value);
  }, 60_000);
});
