/**
 * @file test/mcp/mcp-auth-policy.test.ts
 * @description The one `/mcp` endpoint carries ONE policy: the graph's `X-API-Key` one, driven by
 * the configuration that already exists, and `stdio` carries none.
 *
 * ## The rule under test
 *
 * Two MCP surfaces were merged into one endpoint, so one endpoint cannot carry two policies
 * (S5/S6). The policy is the graph package's own, in `packages/llmwiki-kg/ts/src/auth.ts`: when an
 * API key is CONFIGURED the header is required, when it is not configured the middleware is
 * fail-OPEN and passes every request through — exactly what the graph image does today. The
 * refusal is HTTP 401 with the graph's own `detail` string, byte for byte.
 *
 * ## Why every case spawns the built distribution
 *
 * The claim is about the endpoint `dist/api.js host` binds, behind the configuration the process
 * environment declares. A suite that installed a middleware on a server it built in-process would
 * assert the wiring it just wrote instead of the one the image runs — and the part most likely to
 * be wrong is the part in between: which configuration the process reads, and whether the child
 * actually enforced it. So each case spawns a child with the key (or its absence) in its own
 * environment and speaks JSON-RPC to the listener the child announced.
 *
 * ## Why the four outcomes are separate cases
 *
 * The failure modes are different and a combined case hides which one happened:
 *
 *   - NO header with a key configured → 401 (the endpoint must not serve the tools, S5);
 *   - the CORRECT header → 200 and the same 17-name union (the policy must not swallow the
 *     request it admits);
 *   - a WRONG key → the same 401, proving the comparison is real rather than "a header is
 *     present";
 *   - NO key configured → 200 without a header (pass-through, the current default, S5).
 *
 * ## Why a non-`/mcp` route is asserted in the SAME child as a refusal
 *
 * "The endpoint got stricter" and "the whole listener got stricter" look identical if you only
 * ask about `/mcp`. The scope case therefore asks both questions of one child: `/mcp` refuses
 * without the header, and a route that was unauthenticated before still answers without one. The
 * refusal is what makes the second answer meaningful — it proves the key was in force at that
 * moment, so the open route is an asymmetry this endpoint owns and not a pass-through child.
 *
 * ## Why `stdio` has its own case
 *
 * `serve` has no HTTP headers, so a policy read as "the server is now protected" would be wrong
 * for the container's default mode. With the key configured, the stdio surface must still serve
 * the whole union.
 */
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, waitForReady, type Running } from "../fixtures/launcher-harness.js";
import { connectMcpClient, useMcpRoot } from "../fixtures/mcp-test-env.js";
import { testDotenvEnv } from "../fixtures/test-dotenv.js";
import { EXPECTED_UNION_TOOLS } from "./union-inventory.js";

/** The published MCP path, spelled here so a source edit cannot hide a drift. */
const MCP_PATH = "/mcp";

/**
 * The key the children are configured with. Obviously fake on purpose: this suite asserts a
 * POLICY, never a credential, so the value only has to be one no real deployment would hold.
 */
const CONFIGURED_KEY = "t4-obviously-fake-api-key";

/**
 * The refusal body, byte for byte, as `INVALID_API_KEY_DETAIL` renders it.
 *
 * Written out rather than imported: the point of S6 is that the shipped bytes match the graph's
 * constant, and importing the constant would let a change on both sides pass this suite while
 * breaking every client that already reads the graph's 401.
 */
const REFUSAL_BODY =
  '{"detail":"Invalid or missing API key. Provide it in the X-API-Key header."}';

/** The two variables that declare "no database configured" to a spawned child. */
const FILE_MODE: NodeJS.ProcessEnv = { AKS_DATABASE_URL: "", AKS_STACK_ID: "" };

/** Bound on the wait for a child to leave, so a wedged process cannot hold the suite open. */
const TEARDOWN_BUDGET_MS = 10_000;

/** Headers a streamable-HTTP MCP client must send. */
const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

/** The `initialize` request every MCP client opens with. */
const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "auth-policy-probe", version: "1" },
  },
} as const;

/** The request whose reply is the contract under assertion. */
const TOOLS_LIST_REQUEST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as const;

/** The two members of a JSON-RPC reply this file reads. */
interface RpcReply {
  readonly result?: {
    readonly serverInfo?: { readonly name?: string };
    readonly tools?: readonly { readonly name: string }[];
  };
}

/** One HTTP answer, before any decoding, so the status and the exact bytes are both observable. */
interface RawReply {
  readonly status: number;
  readonly body: string;
}

/**
 * The `host` child's environment with ONE variable decided: the configured API key.
 *
 * The committed corpus comes first and the key last, so an `AKS_API_KEY` in the corpus cannot
 * make the pass-through case assert a protected child.
 *
 * @param apiKey - The key the child is configured with; `""` means "no key configured".
 * @returns The environment to hand the child process.
 */
function hostEnvironment(apiKey: string): NodeJS.ProcessEnv {
  return { ...process.env, ...testDotenvEnv(), ...FILE_MODE, AKS_API_KEY: apiKey };
}

/** SIGTERM a launched child and bound the wait for it to leave. */
async function stopRunning(running: Running): Promise<void> {
  running.terminate();
  await Promise.race([running.exited, sleep(TEARDOWN_BUDGET_MS)]);
}

/**
 * Post one JSON-RPC message to `/mcp`, with or without the configured key.
 *
 * @param base - The base URL the child announced.
 * @param body - The JSON-RPC message.
 * @param apiKey - The `X-API-Key` value to send, or `undefined` to send no such header.
 * @returns The status and the raw body, undecoded, so a refusal can be compared byte for byte.
 */
async function postMcp(base: string, body: unknown, apiKey?: string): Promise<RawReply> {
  const response = await fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers:
      apiKey === undefined ? { ...BASE_HEADERS } : { ...BASE_HEADERS, "X-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

/** Pull the JSON-RPC payload out of an SSE-framed or plain JSON response. */
function rpcPayload(raw: string): RpcReply {
  const framed = raw.match(/^data: (.+)$/m);
  return JSON.parse(framed?.[1] ?? raw) as RpcReply;
}

/** The tool names a `tools/list` reply advertises, sorted. */
function sortedToolNames(reply: RpcReply): string[] {
  return (reply.result?.tools ?? []).map((tool) => tool.name).sort();
}

/**
 * Boot one `host` child with `apiKey` configured and hand it to the case.
 *
 * @param apiKey - The key the child is configured with; `""` means "no key configured".
 * @param run - The case body, receiving the announced base URL.
 */
async function withHost(apiKey: string, run: (base: string) => Promise<void>): Promise<void> {
  const child = launch(["host", "--port", "0"], process.cwd(), hostEnvironment(apiKey));
  try {
    await run(await waitForReady(child));
  } finally {
    await stopRunning(child);
  }
}

/** Close a stdio client and bound the wait, so a wedged child cannot hold the suite open. */
async function closeClient(client: { close(): Promise<void> }): Promise<void> {
  await Promise.race([client.close().catch(() => undefined), sleep(TEARDOWN_BUDGET_MS)]);
}

/**
 * Assert the endpoint REFUSED a request, with the graph's own status and body.
 *
 * @param base - The base URL the child announced.
 * @param apiKey - The `X-API-Key` value to send, or `undefined` to send no such header.
 */
async function expectRefused(base: string, apiKey?: string): Promise<void> {
  const reply = await postMcp(base, INITIALIZE_REQUEST, apiKey);
  // 200 would mean the header was never compared; 500 would mean the refusal is a crash.
  expect(reply.status, `this request must be refused, not served: ${reply.body}`).toBe(401);
  expect(reply.body).toBe(REFUSAL_BODY);
}

/**
 * Assert the endpoint ADMITTED a request, and that it reached the whole union.
 *
 * @param base - The base URL the child announced.
 * @param apiKey - The `X-API-Key` value to send, or `undefined` to send no such header.
 */
async function expectServed(base: string, apiKey?: string): Promise<void> {
  const handshake = await postMcp(base, INITIALIZE_REQUEST, apiKey);
  expect(handshake.status, `this request must be admitted: ${handshake.body}`).toBe(200);
  expect(rpcPayload(handshake.body).result?.serverInfo?.name).toBeTruthy();
  const listing = await postMcp(base, TOOLS_LIST_REQUEST, apiKey);
  expect(listing.status).toBe(200);
  // Whole array: the admitted surface must be the SAME surface, never a reduced one.
  expect(sortedToolNames(rpcPayload(listing.body))).toEqual(EXPECTED_UNION_TOOLS);
}

/**
 * Assert `/mcp` is refused while a route that was open before is still open.
 *
 * One child, one moment: the refusal proves the key is in force, so the open route is an
 * asymmetry this endpoint owns and not a pass-through process.
 *
 * @param base - The base URL the child announced.
 */
async function expectNonMcpOpen(base: string): Promise<void> {
  const refused = await postMcp(base, INITIALIZE_REQUEST);
  expect(refused.status, `the key must be in force for this case to mean anything: ${refused.body}`).toBe(401);
  const health = await fetch(`${base}/health`);
  expect(health.status, "the liveness probe must keep its unauthenticated policy").toBe(200);
  expect((await health.json()) as { status?: string }).toMatchObject({ status: "ok" });
}

describe("the one /mcp endpoint carries the graph API-key policy", () => {
  const root = useMcpRoot("mcp-auth-");

  it("refuses /mcp without X-API-Key when a key is configured", async () => {
    await withHost(CONFIGURED_KEY, expectRefused);
  }, 60_000);

  it("serves the union to a request that carries the configured key", async () => {
    await withHost(CONFIGURED_KEY, (base) => expectServed(base, CONFIGURED_KEY));
  }, 60_000);

  it("refuses a wrong key exactly the way it refuses a missing one", async () => {
    await withHost(CONFIGURED_KEY, (base) => expectRefused(base, `${CONFIGURED_KEY}-wrong`));
  }, 60_000);

  it("leaves a non-/mcp route unauthenticated while the key is configured", async () => {
    await withHost(CONFIGURED_KEY, expectNonMcpOpen);
  }, 60_000);

  it("passes /mcp through unauthenticated when no key is configured", async () => {
    await withHost("", (base) => expectServed(base));
  }, 60_000);

  it("leaves the stdio surface unaffected by a configured key", async () => {
    const { client } = await connectMcpClient(root.value, { ...FILE_MODE, AKS_API_KEY: CONFIGURED_KEY });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(EXPECTED_UNION_TOOLS);
    } finally {
      await closeClient(client);
    }
  }, 60_000);
});
