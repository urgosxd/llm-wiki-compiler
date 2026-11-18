/**
 * @file test/mcp/no-graph-inventory.test.ts
 * @description `host --no-graph` — the mode that serves the wiki tools WITHOUT the graph surface —
 * must advertise the wiki tools and not one graph tool.
 *
 * ## The defect this pins
 *
 * The launcher built the union unconditionally, so the flag removed the graph SURFACE (its REST
 * routes answer 404 in this mode) while the MCP inventory still listed `get_entities`, `query_stack`
 * and `traverse_stack`. Three advertised tools whose only route is the graph API this mode does not
 * mount are dead tools, and a client cannot tell a dead tool from a broken one: it reads the
 * inventory as a contract. Switching the graph off has to mean ABSENT, not present and failing.
 *
 * ## Why the subject is the spawned artifact
 *
 * The flag is parsed in `packages/api/src/main.ts` and the union is composed there, so the claim is
 * about what the shipped launcher advertises. A composed server built inside this process would
 * assert the composition this file performs instead of the one the image performs.
 *
 * ## Why the expectation is derived from the union instead of written out
 *
 * The rule under test is "the union, minus the tools only the graph declares", not "these 14
 * strings". Derived, the case keeps expressing that rule when a wiki tool is added; the count and
 * the explicit absence assertions below keep it from passing by accident. `list_stacks` stays,
 * because the union answers it from the wiki (see `UNION_YIELDS_TO_WIKI`).
 */
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, waitForReady, type Running } from "../fixtures/launcher-harness.js";
import { useMcpRoot } from "../fixtures/mcp-test-env.js";
import { testDotenvEnv } from "../fixtures/test-dotenv.js";
import { EXPECTED_UNION_TOOLS } from "./union-inventory.js";
import { postMcpRpc } from "./mcp-http-probe.js";

/** The three tools whose only implementation is the graph MCP surface. */
const GRAPH_ONLY_TOOLS: readonly string[] = ["get_entities", "query_stack", "traverse_stack"];

/** The inventory `--no-graph` must advertise: the union minus every graph-only tool. */
const EXPECTED_NO_GRAPH_TOOLS: readonly string[] = EXPECTED_UNION_TOOLS.filter(
  (name) => !GRAPH_ONLY_TOOLS.includes(name),
).sort();

/** Bound on the wait for a child to leave, so a wedged process cannot hold the suite open. */
const TEARDOWN_BUDGET_MS = 10_000;

/** The two variables that declare "no database configured", pinned blank so nothing is inherited. */
const FILE_MODE: NodeJS.ProcessEnv = { AKS_DATABASE_URL: "", AKS_STACK_ID: "" };

/** The handshake, and the listing whose reply is the contract under assertion. */
const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "no-graph-probe", version: "1" } },
} as const;
const TOOLS_LIST_REQUEST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as const;

/** Stop a `host` child the way `docker stop` does, bounded. */
async function stopHost(child: Running): Promise<void> {
  child.terminate();
  await Promise.race([child.exited, sleep(TEARDOWN_BUDGET_MS)]);
}

/** The tool names a spawned `host --no-graph` advertises over `/mcp`. */
async function readNoGraphInventory(projectRoot: string): Promise<{ names: string[]; stderr: string }> {
  const child = launch(["host", "--no-graph", "--port", "0"], projectRoot, {
    ...process.env,
    ...testDotenvEnv(),
    ...FILE_MODE,
  });
  try {
    const base = await waitForReady(child);
    await postMcpRpc(base, INITIALIZE_REQUEST);
    const names = ((await postMcpRpc(base, TOOLS_LIST_REQUEST)).result?.tools ?? [])
      .map((tool) => tool.name)
      .sort();
    return { names, stderr: child.stderr() };
  } finally {
    await stopHost(child);
  }
}

describe("host --no-graph advertises no graph tool", () => {
  const root = useMcpRoot("no-graph-");

  it("lists exactly the wiki tools, with the three graph tools absent", async () => {
    const { names, stderr } = await readNoGraphInventory(root.value);
    expect(names, `--no-graph inventory; stderr: ${stderr}`).toEqual(EXPECTED_NO_GRAPH_TOOLS);
    expect(names).toHaveLength(EXPECTED_NO_GRAPH_TOOLS.length);
    for (const dead of GRAPH_ONLY_TOOLS) expect(names).not.toContain(dead);
  }, 60_000);
});
