/**
 * @file test/kg-mcp-e2e/kg-mcp-probe.test.ts
 * @description S1: the KG MCP dimension, end to end, with nothing simulated.
 *
 * Real Postgres container → real KG API (`dist/index.js`) → real HTTP through a
 * counting proxy → real MCP server (`runStdio()`) → real `Client` over
 * `StdioClientTransport`. Each case below is one clause of S1:
 *
 * | Case | S1 clause |
 * | --- | --- |
 * | `stackId` is advertised as required | (a) |
 * | a call without `stackId` is refused with zero downstream requests | (a) |
 * | a named Stack does reach the API | (a), the counter is not vacuous |
 * | `list_stacks` answers the shared contract | (b) |
 * | a valid `stackId` returns that Stack's rows only | (c) |
 * | a malformed id is refused before the API is reached | (d) |
 *
 * Every refusal case additionally compares stored row counts and the proxy's
 * counters before and after, which is S6's "rejected input changes nothing".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRACT_STACK_KEYS } from "../../packages/llmwiki-kg/ts/src/mcp-harness.js";
import { dockerAvailable } from "../fixtures/ephemeral-postgres.js";
import { textOf } from "./kg-mcp-child.js";
import type { SeededStack } from "./probe-database.js";
import { startProbe } from "./probe-harness.js";
import type { Probe } from "./probe-harness.js";

/** Standing the stack up includes a package build, so the default 60 s is not enough. */
const HOOK_TIMEOUT_MS = 240_000;

/** A tool call crosses five processes; 30 s would be a flake waiting to happen. */
const TEST_TIMEOUT_MS = 40_000;

/** The refusal every graph tool gives when the call names no Stack. */
const MISSING_STACK_TEXT = "Error: 'stackId' must be provided.";

/** The refusal a malformed id gets, worded once by the shared Stack-id rule. */
const MALFORMED_STACK_ID = "not-a-uuid";

const MALFORMED_STACK_ID_TEXT = `Error: '${MALFORMED_STACK_ID}' is not a Stack id. Stack ids are UUIDs — call list_stacks to see the ones this endpoint can reach.`;

/** What `get_entities` answers for the alpha Stack, byte for byte. */
const ALPHA_ENTITIES = [
  "Found 2 entities:",
  "",
  "• Alpha Gateway [System, conf 0.75] ✓",
  "  Routes alpha traffic.",
  "• Alpha Ledger [Process, conf 0.50]",
].join("\n");

/** What `get_entities` answers for the beta Stack: different names, different values. */
const BETA_ENTITIES = [
  "Found 2 entities:",
  "",
  "• Beta Gateway [System, conf 0.50] ✓",
  "  Routes beta traffic.",
  "• Beta Ledger [Process, conf 0.25]",
].join("\n");

/** What `traverse_stack` answers from the alpha Stack's starting entity. */
const ALPHA_TRAVERSE = [
  "Traversal from: Alpha Gateway",
  "Max depth: 2",
  "Entities reached: 2",
  "",
  "Path (1 steps):",
  "  • Alpha Gateway —[requires]→ Alpha Ledger (depth 1, conf 0.75)",
].join("\n");

/** What `traverse_stack` answers from the beta Stack's starting entity. */
const BETA_TRAVERSE = [
  "Traversal from: Beta Gateway",
  "Max depth: 2",
  "Entities reached: 2",
  "",
  "Path (1 steps):",
  "  • Beta Gateway —[requires]→ Beta Ledger (depth 1, conf 0.50)",
].join("\n");

/**
 * The alpha Stack as `list_stacks` must render it.
 *
 * Ten keys in contract order, the timestamps the seed wrote, and `isCurrent` false:
 * this dimension is bound to no Stack, so nothing is marked.
 */
function contractEntry(stack: SeededStack, description: string | null): Record<string, unknown> {
  return {
    id: stack.id,
    name: stack.name,
    domain: stack.domain,
    description,
    scope: "stack",
    compilationStrategy: "incremental",
    synthesizeDescriptions: false,
    createdAt: stack.createdAt,
    updatedAt: stack.updatedAt,
    isCurrent: false,
  };
}

let probe: Probe | undefined;
let dockerProblem = "docker info did not succeed";

/** The probe, or a skip naming the capability that is missing. */
function requireProbe(ctx: { skip: (note?: string) => void }): Probe {
  if (probe === undefined) {
    ctx.skip(dockerProblem);
    throw new Error("unreachable: ctx.skip() throws");
  }
  return probe;
}

/**
 * Drive every listed call and prove each one was refused HERE, before the network.
 *
 * The two refusal cases differ only in the arguments they send, the wording of the
 * failure and the message that must come back; the shape of the proof — an
 * `isError` result, the exact text, and no request leaving the process for that
 * call — is identical, so it is written once.
 *
 * @param probe - The connected MCP client and the proxy's request log.
 * @param calls - Tool name and arguments for each call that must be refused.
 * @param refusal - `reason` completes "<tool> must …"; `text` is the exact answer.
 */
async function expectEveryCallRefused(
  { mcp, requests }: Pick<Probe, "mcp" | "requests">,
  calls: ReadonlyArray<[string, Record<string, unknown>]>,
  refusal: { reason: string; text: string },
): Promise<void> {
  for (const [name, args] of calls) {
    const seenBefore = requests().length;
    const result = await mcp.call(name, args);
    expect(result.isError, `${name} must ${refusal.reason}`).toBe(true);
    expect(textOf(result), name).toBe(refusal.text);
    expect(requests().slice(seenBefore), `${name} must not reach the API`).toHaveLength(0);
  }
}

beforeAll(async () => {
  if (!(await dockerAvailable())) {
    dockerProblem = "docker daemon is not reachable from this process (`docker info` failed)";
    return;
  }
  probe = await startProbe();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (probe !== undefined) {
    const { timings } = probe;
    console.log(`kg-mcp-e2e timings (ms): ${JSON.stringify(timings)}`);
  }
  await probe?.stop();
}, HOOK_TIMEOUT_MS);

describe("KG MCP probe: real Postgres, real API, real stdio handshake", () => {
  it("advertises stackId as required on every graph tool", async (ctx) => {
    const { mcp } = requireProbe(ctx);
    const { tools } = await mcp.listTools();
    const required = Object.fromEntries(
      tools.map((tool) => [tool.name, (tool.inputSchema as { required?: string[] }).required]),
    );
    expect(required["query_stack"]).toEqual(["query", "stackId"]);
    expect(required["traverse_stack"]).toEqual(["start", "stackId"]);
    expect(required["get_entities"]).toEqual(["stackId"]);
    // `list_stacks` is the exemption: a discovery tool cannot require the id it discovers.
    expect(required["list_stacks"]).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it("refuses each graph tool without stackId, with zero downstream requests", async (ctx) => {
    const { mcp, requests, counts } = requireProbe(ctx);
    const before = await counts();
    const calls: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["query_stack", { query: "what does this Stack know?" }],
      ["traverse_stack", { start: "Alpha Gateway" }],
      ["get_entities", {}],
    ];
    await expectEveryCallRefused({ mcp, requests }, calls, {
      reason: "refuse a call that names no Stack",
      text: MISSING_STACK_TEXT,
    });
    expect(await counts()).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it("forwards a named Stack to the real API, so that zero is not vacuous", async (ctx) => {
    const { mcp, requests, seed } = requireProbe(ctx);
    const result = await mcp.call("query_stack", {
      query: "which service routes traffic?",
      stackId: seed.alpha.id,
    });
    // The answer's model layer is a network dependency this probe does not own; what
    // it proves is the Stack crossing the boundary, which is where the refusal rule
    // lives. So the assertion is on the request, not on a model's prose.
    expect(result.isError ?? false).toBe(false);
    const sent = requests().filter((entry) => entry.method === "POST" && entry.path === "/aks/v1/context");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ stackId: seed.alpha.id });
  }, TEST_TIMEOUT_MS);

  it("answers list_stacks with the shared {stacks, count} contract", async (ctx) => {
    const { mcp, seed } = requireProbe(ctx);
    const result = await mcp.call("list_stacks", {});
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(textOf(result)) as { stacks: Record<string, unknown>[]; count: number };
    expect(Object.keys(payload)).toEqual(["stacks", "count"]);
    expect(payload.count).toBe(payload.stacks.length);
    expect(payload.stacks).toHaveLength(2);
    for (const entry of payload.stacks) expect(Object.keys(entry)).toEqual([...CONTRACT_STACK_KEYS]);
    const byId = new Map(payload.stacks.map((entry) => [entry["id"], entry]));
    expect(byId.get(seed.alpha.id)).toEqual(contractEntry(seed.alpha, "The Stack this probe queries first."));
    expect(byId.get(seed.beta.id)).toEqual(contractEntry(seed.beta, null));
  }, TEST_TIMEOUT_MS);

  it("returns only the rows of the Stack it was given", async (ctx) => {
    const { mcp, seed } = requireProbe(ctx);
    const alpha = textOf(await mcp.call("get_entities", { stackId: seed.alpha.id }));
    const beta = textOf(await mcp.call("get_entities", { stackId: seed.beta.id }));
    expect(alpha).toBe(ALPHA_ENTITIES);
    expect(beta).toBe(BETA_ENTITIES);
    // The payload carries no row of the other Stack, by name and by value.
    expect(alpha).not.toContain("Beta");
    expect(beta).not.toContain("Alpha");
  }, TEST_TIMEOUT_MS);

  it("traverses only within the Stack it was given", async (ctx) => {
    const { mcp, seed } = requireProbe(ctx);
    const alpha = textOf(await mcp.call("traverse_stack", { start: "Alpha Gateway", stackId: seed.alpha.id }));
    const beta = textOf(await mcp.call("traverse_stack", { start: "Beta Gateway", stackId: seed.beta.id }));
    expect(alpha).toBe(ALPHA_TRAVERSE);
    expect(beta).toBe(BETA_TRAVERSE);
    expect(alpha).not.toContain("Beta");
    expect(beta).not.toContain("Alpha");
  }, TEST_TIMEOUT_MS);

  it("refuses a malformed Stack id before any request reaches the API", async (ctx) => {
    const { mcp, requests, counts } = requireProbe(ctx);
    const before = await counts();
    const calls: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["query_stack", { query: "q", stackId: MALFORMED_STACK_ID }],
      ["traverse_stack", { start: "Alpha Gateway", stackId: MALFORMED_STACK_ID }],
      ["get_entities", { stackId: MALFORMED_STACK_ID }],
      ["list_stacks", { stackId: MALFORMED_STACK_ID }],
    ];
    await expectEveryCallRefused({ mcp, requests }, calls, {
      reason: "refuse a malformed Stack id",
      text: MALFORMED_STACK_ID_TEXT,
    });
    expect(await counts()).toEqual(before);
  }, TEST_TIMEOUT_MS);
});
