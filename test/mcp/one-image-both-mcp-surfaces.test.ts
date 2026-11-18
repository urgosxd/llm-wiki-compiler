/**
 * @file test/mcp/one-image-both-mcp-surfaces.test.ts
 * @description The BUILT DISTRIBUTION must advertise the KG tools on the same surface as the
 * wiki tools, over both transports the one published image speaks.
 *
 * ## Why the subject is `dist/api.js` and not a composed server
 *
 * The defect this guards against is not "the KG tools are missing from the source": they exist,
 * fully implemented, behind `createKgApp`. The defect is that the composition that reaches
 * `dist/api.js` never mounts them, so the shipped image serves 14 wiki tools and none of the four
 * KG tools (`query_stack`, `traverse_stack`, `get_entities`, and a second `list_stacks`).
 *
 * A test that builds a server in this process — `buildServer` from `test/fixtures/mcp-test-env.ts`,
 * or any `createWikiMcpServer`/`createKgServer` pair joined by hand — passes while the artifact
 * ships without the tools, because it asserts the composition it just performed instead of the one
 * the image performs. That is a green about the wrong object. So every case here spawns the built
 * launcher and speaks MCP to it across a real process boundary:
 *
 *   - stdio: `node dist/api.js serve --root <dir>`, driven by `StdioClientTransport` (the SDK's
 *     `initialize` handshake is `Client.connect`, `tools/list` is `client.listTools`);
 *   - HTTP: `node dist/api.js host --port 0`, driven by JSON-RPC `POST <base>/mcp`, the same
 *     stateless streamable-HTTP shape `packages/api/src/host/mcp-http.ts` serves.
 *
 * `test/global-setup.ts` builds `dist/` once before any file loads, so a missing artifact fails
 * the launcher fixture's precondition rather than being silently skipped.
 *
 * ## Why the whole name array, not a count and not a set of "KGs present"
 *
 * `tools/list` is the contract an agent builds its arguments from. A missing name means the tool
 * is unreachable; a DUPLICATED name means the same tool is registered twice and which
 * implementation answers is undefined. Comparing the sorted array to a literal expected array fails
 * on both, and the length assertion states the count in the failure message so a reader sees
 * "14 vs 17" instead of hunting a diff.
 *
 * ## Why the children are pinned to the file mode
 *
 * The runner seeds a database URL into every worker, and a spawned child inherits it. Both cases
 * pin `AKS_DATABASE_URL` BLANK (present and empty, never deleted — `dotenv` refills a deleted key
 * from the committed corpus, which names a database) so this suite asserts a tool INVENTORY, which
 * does not depend on rows, against a deterministic child. The ledger of that chain lives in
 * `test/fixtures/run-cli-server.ts` and `test/fixtures/mcp-test-env.ts`; this file records only the
 * two variables it needs, because it spawns one child of each kind rather than going through a
 * per-suite lifecycle helper.
 *
 * ## Why two more cases CALL a KG tool instead of only listing it
 *
 * A name in `tools/list` proves the tool was REGISTERED; it does not prove the call reaches the KG
 * implementation, and it says nothing about whether one surface's failure can take the other down.
 * So the last two cases call through the same stdio client a consumer uses:
 *
 *   - the end-to-end case owns a per-run database, creates a Stack over the host's own HTTP
 *     surface and asks `get_entities` for it. The KG tools are HTTP clients of the graph API, so
 *     the successful answer proves the whole chain — union server, KG dispatch, the listener this
 *     image already mounts, Postgres — and not merely that a name is advertised;
 *   - the isolation case points the KG surface at a CLOSED loopback port while a real database and
 *     a real Stack stay in reach, which is the failure S7 has to contain: the KG call answers an
 *     error result for itself and a wiki tool still answers afterwards, in the same session. The
 *     database is not decoration — without it the wiki tool would fail for a reason that has
 *     nothing to do with isolation (`lint_wiki` resolves its corpus through the database), and the
 *     case would pass while proving nothing.
 */
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, waitForReady, type Running } from "../fixtures/launcher-harness.js";
import { connectMcpClient, useMcpRoot } from "../fixtures/mcp-test-env.js";
import { createSuiteDatabase, type SuiteDatabase } from "../fixtures/per-run-database.js";
import { testDotenvEnv } from "../fixtures/test-dotenv.js";
// The inventory lives in one module because the auth suite asserts the SAME surface an
// authenticated request reaches: two copies of this array would drift on the next tool.
import { EXPECTED_UNION_TOOLS as EXPECTED_TOOLS } from "./union-inventory.js";

/** The published MCP path (`MCP_HTTP_PATH`), spelled here so a source edit cannot hide a drift. */
const MCP_PATH = "/mcp";

/**
 * The two variables that declare "no database configured" to a spawned child, pinned BLANK so the
 * corpus cannot refill them and a Stack cannot be inherited from this worker.
 */
const FILE_MODE: NodeJS.ProcessEnv = { AKS_DATABASE_URL: "", AKS_STACK_ID: "" };

/** Bound on the wait for a child to leave, so a wedged process cannot hold the suite open. */
const TEARDOWN_BUDGET_MS = 10_000;

/**
 * A loopback port nothing listens on, so a KG tool that reaches its HTTP boundary fails there.
 *
 * Port 1 is reserved and unbindable, which makes "the connection is refused" a property of the
 * number rather than of whatever else this machine happens to be running.
 */
const CLOSED_BASE_URL = "http://127.0.0.1:1";

/** Headers a streamable-HTTP MCP client must send. */
const MCP_HEADERS = {
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
    clientInfo: { name: "one-image-probe", version: "1" },
  },
} as const;

/** The request whose reply is the contract under assertion. */
const TOOLS_LIST_REQUEST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as const;

/** The two members of a JSON-RPC reply this file reads. */
interface RpcReply {
  readonly result?: {
    readonly serverInfo?: { readonly name?: string; readonly version?: string };
    readonly tools?: readonly { readonly name: string }[];
  };
}

/** The `host` child's environment: the committed corpus, then the file-mode declaration. */
function hostEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, ...testDotenvEnv(), ...FILE_MODE };
}

/** Pull the JSON-RPC payload out of an SSE-framed or plain JSON response. */
function rpcPayload(raw: string): RpcReply {
  const framed = raw.match(/^data: (.+)$/m);
  return JSON.parse(framed?.[1] ?? raw) as RpcReply;
}

/** Post one JSON-RPC message to `/mcp` and decode its reply. */
async function rpc(base: string, body: unknown): Promise<RpcReply> {
  const response = await fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return rpcPayload(await response.text());
}

/** The tool names a `tools/list` reply advertises, sorted. */
function sortedToolNames(reply: RpcReply): string[] {
  return (reply.result?.tools ?? []).map((tool) => tool.name).sort();
}

/** The text blocks of a tool result, joined the way a client renders them. */
function resultText(result: unknown): string {
  const content = (result as { readonly content?: unknown }).content;
  const blocks = Array.isArray(content) ? (content as { type: string; text?: string }[]) : [];
  return blocks.map((block) => block.text ?? "").join("");
}

/**
 * Close a client and bound the wait.
 *
 * The transport ends stdin, then SIGTERMs and finally SIGKILLs the child; the race is the outer
 * backstop so a child that outlives all three cannot hold the suite open.
 */
async function closeClient(client: { close(): Promise<void> }): Promise<void> {
  await Promise.race([client.close().catch(() => undefined), sleep(TEARDOWN_BUDGET_MS)]);
}

/** SIGTERM a launched child and bound the wait for it to leave. */
async function stopRunning(running: Running): Promise<void> {
  running.terminate();
  await Promise.race([running.exited, sleep(TEARDOWN_BUDGET_MS)]);
}

/** A running `host` child, the database it serves, and the one Stack created over its own HTTP. */
interface UnionHost {
  /** The per-run database both layers of the child are pointed at. */
  readonly suite: SuiteDatabase;
  /** The child, so a case's `finally` stops it. */
  readonly running: Running;
  /** The base URL it announced. */
  readonly base: string;
  /** The Stack `POST /stacks` created, which every tool call names. */
  readonly stackId: string;
  /** Stop the child and drop the database; called from the case's `finally`. */
  release(): Promise<void>;
}

/**
 * Boot `host` against a database of this case's own and create the Stack the tools need.
 *
 * The Stack is created through the listener the child announced — not through SQL and not through
 * a second composition — because the S10 claim is about the surface this image serves.
 *
 * @param label - The per-run database's name, so a failure says whose state was wrong.
 * @param projectRoot - The `serve`/`host` root the child is pointed at.
 * @returns The child, its base URL, and the Stack a tool call can name.
 */
async function bootUnionHost(label: string, projectRoot: string): Promise<UnionHost> {
  const suite = await createSuiteDatabase(label);
  const running = launch(["host", "--port", "0"], projectRoot, {
    ...hostEnvironment(),
    // The graph sub-app resolves its OWN pool from `DATABASE_URL`, so a case that pointed only the
    // dimensions layer at the throwaway database would call a route that never reaches it.
    AKS_DATABASE_URL: suite.url,
    DATABASE_URL: suite.url,
  });
  try {
    const base = await waitForReady(running);
    const created = await fetch(`${base}/stacks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Union probe", domain: "union-probe" }),
    });
    expect(created.status, `POST /stacks must create the probe Stack: ${await created.clone().text()}`).toBe(201);
    const { id } = (await created.json()) as { id: string };
    return {
      suite,
      running,
      base,
      stackId: id,
      release: async (): Promise<void> => {
        await stopRunning(running);
        await suite.drop();
      },
    };
  } catch (error) {
    // A failed boot still owns a child and a database; leaking either would poison the next case.
    await stopRunning(running);
    await suite.drop();
    throw error;
  }
}

describe("the built distribution serves both MCP tool sets", () => {
  const root = useMcpRoot("one-image-");

  it("advertises the wiki and KG tools together over stdio", async () => {
    const { client } = await connectMcpClient(root.value, FILE_MODE);
    try {
      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBeTruthy();
      expect(serverInfo?.version).toBeTruthy();
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      // Whole-array first, so a failure names every missing and every duplicated tool; the count
      // assertion then states 14-vs-17 in one line instead of leaving the reader to count a diff.
      expect(names).toEqual(EXPECTED_TOOLS);
      expect(names).toHaveLength(EXPECTED_TOOLS.length);
    } finally {
      await closeClient(client);
    }
  }, 60_000);

  it("advertises the same union over streamable HTTP at /mcp", async () => {
    const child = launch(["host", "--port", "0"], root.value, hostEnvironment());
    try {
      const base = await waitForReady(child);
      const handshake = await rpc(base, INITIALIZE_REQUEST);
      expect(handshake.result?.serverInfo?.name).toBeTruthy();
      const names = sortedToolNames(await rpc(base, TOOLS_LIST_REQUEST));
      expect(names).toEqual(EXPECTED_TOOLS);
      expect(names).toHaveLength(EXPECTED_TOOLS.length);
    } finally {
      await stopRunning(child);
    }
  }, 60_000);
});

/**
 * A name in `tools/list` is a registration; only a CALL proves the wiring, and only a second call
 * proves that one surface's failure stayed with the surface that failed.
 */
describe("the union answers a KG tool and keeps the surfaces isolated", () => {
  const root = useMcpRoot("one-image-call-");

  it("answers a real KG tool call over stdio, end to end against a database", async () => {
    const host = await bootUnionHost("one-image-kg-call", root.value);
    try {
      const { client } = await connectMcpClient(root.value, { AKS_DATABASE_URL: "", AKS_BASE_URL: host.base });
      try {
        const result = await client.callTool({ name: "get_entities", arguments: { stackId: host.stackId } });
        expect(result.isError ?? false).toBe(false);
        // The KG surface's own empty-listing wording: an answer produced by the KG handler and by
        // nothing else, which is what makes this a wiring proof and not a registration one.
        expect(resultText(result)).toBe("(No entities matched the filter)");
      } finally {
        await closeClient(client);
      }
    } finally {
      await host.release();
    }
  }, 60_000);

  it("keeps a wiki tool answering after a KG tool fails", async () => {
    const host = await bootUnionHost("one-image-kg-isolation", root.value);
    try {
      await expectIsolatedWikiAnswer(host, root.value);
    } finally {
      await host.release();
    }
  }, 60_000);
});

/**
 * Call a graph tool that cannot reach its backend, then require a wiki tool to answer anyway.
 *
 * The graph tool fails where it must — at its own HTTP boundary — while a real database and a
 * real Stack stay in reach, so the wiki answer proves isolation rather than the absence of a
 * dependency both surfaces happen to share.
 *
 * @param host - The database-backed host whose Stack every call names.
 * @param projectRoot - The root the stdio child serves.
 */
async function expectIsolatedWikiAnswer(host: UnionHost, projectRoot: string): Promise<void> {
  const { client } = await connectMcpClient(projectRoot, {
    AKS_DATABASE_URL: host.suite.url,
    DATABASE_URL: host.suite.url,
    AKS_BASE_URL: CLOSED_BASE_URL,
  });
  try {
    const kg = await client.callTool({ name: "get_entities", arguments: { stackId: host.stackId } });
    expect(kg.isError, "a KG tool that cannot reach its backend must answer an error result").toBe(true);
    expect(resultText(kg)).not.toMatch(/not found|unknown tool|-3260\d/i);
    const wiki = await client.callTool({ name: "lint_wiki", arguments: { stackId: host.stackId } });
    expect(wiki.isError ?? false, "the wiki tool must still answer in the same session").toBe(false);
    expect(() => JSON.parse(resultText(wiki))).not.toThrow();
  } finally {
    await closeClient(client);
  }
}
