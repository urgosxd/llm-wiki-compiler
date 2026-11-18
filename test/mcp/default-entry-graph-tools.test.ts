/**
 * @file test/mcp/default-entry-graph-tools.test.ts
 * @description Composition is not reachability. `node dist/api.js serve` — the command
 * `docker/entry.sh` runs when the container gets no arguments (`docker/entry.sh:104`) — must
 * ANSWER all three graph tools, not merely list them.
 *
 * ## Why this file exists, and what it pins that `tools/list` does not
 *
 * The union is composed once and both transports start from it, so the inventory looked correct
 * the whole time the container's default mode was broken. What was wrong was reachability: with no
 * graph API named, the three graph tools dialled `http://localhost:8000` — the MCP config's own
 * default — where nothing listened, so every call answered `fetch failed`. A tool advertised in
 * `tools/list` that cannot serve is WORSE than an absent tool, because the client reads the
 * inventory as a contract and reports the capability to its user.
 *
 * So the subject here is a CALL per tool, made through the same stdio client a consumer uses, with
 * the environment the default entrypoint gets: no external graph API, no database.
 *
 * ## Why the subject is a spawned artifact and not a composed server
 *
 * A server built inside this process would assert the composition this file performs. The claim is
 * about the shipped launcher, so the child is `node dist/api.js serve --root <tmp>` across a real
 * process boundary — exactly what the container's default command runs, which guards the container's
 * default surface without needing Docker. `test/global-setup.ts` builds `dist/` before any file
 * loads, so a missing artifact fails the fixture rather than being skipped.
 *
 * ## What the graph tools are allowed to answer with no database
 *
 * The graph tools are HTTP clients of a graph API and the child has no reachable database, so the
 * honest outcome is the graph surface's OWN envelope — `AKS server returned <status>: <body>`, which
 * only an HTTP RESPONSE produces. That envelope is the reachability proof: the route ran in this
 * same process and failed on Postgres. `fetch failed` is the opposite fact — a dead socket — and it
 * is the one this file exists to catch.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectMcpClient, useMcpRoot, type McpClientHandle } from "../fixtures/mcp-test-env.js";

/** A loopback port nothing listens on, so "no database" is a property of the value, not the host. */
const CLOSED_DATABASE_URL = "postgresql://aks:aks@127.0.0.1:1/aks";

/**
 * The text only a graph ROUTE that answered can produce. The status is not asserted: with no
 * database it is a failure, and which one depends on how the pool fails, not on this feature.
 */
const GRAPH_ENVELOPE = /^AKS server returned \d{3}: /;

/**
 * The child's environment: what the container's default command gets — no graph API, no database.
 *
 * Every variable is pinned BLANK or to a closed port rather than deleted, because a deleted key is
 * refilled from the committed test corpus by `dotenv`, and `AKS_BASE_URL`/`AKS_DATABASE_URL` left
 * inherited would name whatever the developer's shell or this worker holds. Blank reads as
 * "not configured" to every production reader (`configuredKgBaseUrl` and `isDatabaseConfigured` both
 * ask `(value ?? "").trim() !== ""`), so blank IS unset here, and it survives the dotenv load.
 * `DATABASE_URL` is pinned to the closed port for the same reason: left inherited it would name this
 * worker's per-run database, and the outcome would depend on what this machine happens to run.
 */
const CONTAINER_ENV: NodeJS.ProcessEnv = {
  AKS_BASE_URL: "",
  AKS_DATABASE_URL: "",
  AKS_STACK_ID: "",
  DATABASE_URL: CLOSED_DATABASE_URL,
};

/** One graph tool, called with exactly the arguments its own schema declares as required. */
interface GraphCall {
  /** The tool name advertised on the union surface. */
  readonly name: string;
  /** The arguments, read from `packages/llmwiki-kg/ts/src/mcp/tools.ts:81`, `:109`, `:142`. */
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The three graph tools and their required arguments.
 *
 * `query_stack` requires `query` and `stackId`, `traverse_stack` requires `start` and `stackId`,
 * `get_entities` requires only `stackId`. These are read from the tool definitions, not guessed:
 * a call that failed schema validation would prove nothing about reachability.
 *
 * @param stackId - A well-formed Stack id; no Stack exists, which is the point.
 * @returns One call per graph tool.
 */
function graphCalls(stackId: string): readonly GraphCall[] {
  return [
    { name: "query_stack", args: { query: "what is a stack", stackId } },
    { name: "traverse_stack", args: { start: "Knowledge Stack", stackId } },
    { name: "get_entities", args: { stackId } },
  ];
}

/** Call one tool over the live session and return the text a client would render. */
async function callText(session: McpClientHandle, call: GraphCall): Promise<string> {
  const result = await session.client.callTool({ name: call.name, arguments: { ...call.args } });
  const blocks = (result.content ?? []) as { readonly type: string; readonly text?: string }[];
  return blocks.map((block) => block.text ?? "").join("");
}

/** Call every graph tool once and assert each answered from a live graph route. */
async function expectEveryGraphToolAnswers(session: McpClientHandle): Promise<void> {
  for (const call of graphCalls(randomUUID())) {
    const text = await callText(session, call);
    expect(
      text,
      `${call.name} answered ${JSON.stringify(text)}. \`fetch failed\` means the tool dialled a port ` +
        "nothing listens on: it was advertised in tools/list and cannot serve, which is worse than " +
        "an absent tool and is the defect this file exists to catch",
    ).not.toMatch(/fetch failed/i);
    expect(
      text,
      `${call.name} must answer with the graph surface's own envelope (${GRAPH_ENVELOPE}), which ` +
        `only an HTTP response produces. Got: ${JSON.stringify(text)}`,
    ).toMatch(GRAPH_ENVELOPE);
  }
}

describe("the container's default command serves all three graph tools", () => {
  const root = useMcpRoot("default-entry-graph-tools-");

  it("answers query_stack, traverse_stack and get_entities with no graph API named", async () => {
    const session = await connectMcpClient(root.value, CONTAINER_ENV);
    try {
      await expectEveryGraphToolAnswers(session);
    } finally {
      await session.client.close();
    }
  }, 60_000);
});
