/**
 * @file test/mcp/stack-argument-required-refusal.test.ts
 * @description S2 and S4: a tool call with no `stackId` is REFUSED, names the
 * argument, and touches nothing.
 *
 * ## Why the calls go over the transport and not through the handler
 *
 * The refusal under test is the SDK's own input validation against the registered
 * schema. `callTool()` in `test/fixtures/mcp-test-env.ts` reaches into
 * `_registeredTools` and invokes the handler directly, which skips validation
 * entirely — a suite built on it would keep passing after the argument became
 * required. A real `Client` over `InMemoryTransport` is the path an agent takes.
 *
 * ## Why the ambient Stack is deliberately bound during these cases
 *
 * A deployment that serves one Stack still exports `AKS_STACK_ID`, and that ambient
 * value is what the old code substituted when the argument was missing. Binding a
 * real Stack here — and seeding it with a page the refusal cases then ask for —
 * means a surviving fallback cannot pass: it would answer with that page's body.
 *
 * ## Why every tool except `list_stacks` is in the table
 *
 * `list_stacks` is exempt by ruling: a discovery tool cannot require the identifier of
 * the thing it discovers, so an omitted argument there still resolves the bound Stack.
 * It is asserted the opposite way in `tools-list-requires-stack.test.ts`.
 *
 * ## Why the writes are counted, and on WHICH Stacks
 *
 * "It refused" is not enough. A refusal that still ran compile, eval-with-record or a
 * saving query leaves rows behind while telling the caller nothing happened. The
 * counter case drives all ten calls and compares per-Stack row counts on both sides.
 *
 * The counts are keyed to Stacks THIS TEST owns, never to a whole-table total. A
 * global total (`{ stacks: 3995, pages: 598, jobs: 39 }`) is the flake it replaced: a
 * sibling suite creating its own Stack in parallel moves it, and the difference is
 * indistinguishable from a cross-tenant write by this call. Two owned Stacks are
 * measured instead:
 *
 * - the AMBIENT-BOUND Stack, because `AKS_STACK_ID` is the one tenant a
 *   missing-argument fallback could ever reach — the call names no Stack, so the
 *   deployment's own Stack is the whole of its reach;
 * - a second Stack the case NAMES explicitly afterwards, because a handler that
 *   resolves the Stack from the argument must touch that one and leave the bound
 *   Stack alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { buildServer } from "../fixtures/mcp-test-env.js";
import { useQueryStackFixture } from "../fixtures/query-stack-root.js";
import type { QueryStackFixture } from "../fixtures/query-stack-root.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** Slug the ambient Stack holds, so a fallback would find something to serve. */
const SLUG = "shared";

/** Body that is reachable ONLY through a Stack named in the argument. */
const ROW_BODY = "ROW_BODY_only_reachable_through_the_stack_argument";

/** Slug the second, case-owned Stack holds, to prove a named call reached it. */
const NAMED_SLUG = "named-only";

/** Body only the NAMED Stack holds, so the read cannot be answered by the bound one. */
const NAMED_BODY = "ROW_BODY_only_reachable_through_the_named_stack_argument";

/**
 * What an MCP client prints when the SDK rejects a call missing `stackId`.
 *
 * Frozen deliberately: the prefix is the SDK's (`MCP error -32602: Input validation
 * error: Invalid arguments for tool …`) and the tail is the validator's, naming the
 * argument. A caller switching on the text needs both halves stable.
 */
function refusalText(toolName: string): string {
  return (
    `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ` +
    "Invalid input: expected string, received undefined at stackId"
  );
}

/**
 * Every Stack-scoped tool with the minimum OTHER arguments it needs.
 *
 * The write-enabling options are set on purpose (`save`, `record`) so that a call
 * that slipped past validation would leave observable rows behind.
 */
const MISSING_STACK_CALLS: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  { name: "compile_wiki", args: {} },
  { name: "run_eval", args: { record: true } },
  { name: "query_wiki", args: { question: "what is row only?", save: true } },
  { name: "search_pages", args: { question: "row only" } },
  { name: "read_page", args: { slug: SLUG } },
  { name: "lint_wiki", args: {} },
  { name: "wiki_status", args: {} },
  { name: "get_context_pack", args: { prompt: "row only" } },
  { name: "ingest_job_status", args: { jobId: "ing_01ARYZ6S41TSV4RRFFQ69G5FAV" } },
  { name: "ingest_jobs_list", args: {} },
];

/** Join the text blocks of a tool envelope, which is all a client can branch on. */
function textOf(result: CallToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("");
}

/** Seed the ambient Stack with a page the refusal cases go looking for. */
async function seedAmbientPage(fixture: QueryStackFixture): Promise<void> {
  await createPageWriteSink(fixture.stack.harness.db, fixture.stack.harness.stackId)({
    directory: "concepts",
    slug: SLUG,
    body: `---\ntitle: Shared\nsummary: ambient\n---\n\n${ROW_BODY}\n`,
  });
}

/** Row counts ONE Stack owns: everything a refused call could have written there. */
interface StackCounts {
  pages: number;
  /** `wiki.review_candidates` — where a saving query or an import would stage. */
  candidates: number;
  /** `wiki.ingest_job` — where a compile or an ingest records work. */
  jobs: number;
  /** `wiki.derived_artifact` — the index/MOC render a compile regenerates. */
  artifacts: number;
  /** `wiki.activity_log` — the history row a successful operation appends. */
  activity: number;
}

/** The Stack-scoped tables a refused call must leave byte-identical, by counter name. */
const COUNTED_TABLES: ReadonlyArray<[keyof StackCounts, string]> = [
  ["pages", "wiki.pages"],
  ["candidates", "wiki.review_candidates"],
  ["jobs", "wiki.ingest_job"],
  ["artifacts", "wiki.derived_artifact"],
  ["activity", "wiki.activity_log"],
];

/**
 * The row counts `stackId` owns, zero-filled where the Stack holds nothing.
 *
 * Scoped to the Stack, never to the whole table: a sibling suite writing to its OWN
 * Stack must not be able to make this case fail, and a write of OURS must not be able
 * to hide in someone else's total.
 *
 * @param harness - Database handle of the suite.
 * @param stackId - The one Stack to measure.
 * @returns Its counts across every table a tool could write.
 */
async function countsOf(harness: KgPostgresHarness, stackId: string): Promise<StackCounts> {
  const counts: StackCounts = { pages: 0, candidates: 0, jobs: 0, artifacts: 0, activity: 0 };
  for (const [key, table] of COUNTED_TABLES) {
    const [row] = await harness.db.execute(
      `select count(*)::int as n from ${table} where stack_id = '${stackId}'`,
    );
    counts[key] = Number((row as { n: number }).n);
  }
  return counts;
}

/**
 * Store one page in the second Stack, so a call naming it has something to return.
 *
 * @param probe - The Stack the case names explicitly.
 */
async function seedNamedPage(probe: ProbeStack): Promise<void> {
  await createPageWriteSink(probe.harness.db, probe.harness.stackId)({
    directory: "concepts",
    slug: NAMED_SLUG,
    body: `---\ntitle: Named\nsummary: named\n---\n\n${NAMED_BODY}\n`,
  });
}

describe("a tool call that omits the required Stack argument", () => {
  const fixture = useQueryStackFixture("stack-arg-required", "stack-arg-required-");
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    server = buildServer(fixture().root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "stack-arg-required", version: "0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it.each(MISSING_STACK_CALLS)("$name is refused and the refusal names stackId", async ({ name, args }) => {
    const result = await client.callTool({ name, arguments: args });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(refusalText(name));
  });

  it("pins the exact refusal the previously working read_page call now gets", async () => {
    const result = await client.callTool({ name: "read_page", arguments: { slug: SLUG } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "MCP error -32602: Input validation error: Invalid arguments for tool read_page: " +
        "Invalid input: expected string, received undefined at stackId",
    );
  });

  it("refuses instead of reading the Stack the deployment is bound to", async () => {
    if (!fixture().stack.harness.reachable) return;
    await seedAmbientPage(fixture());

    const result = await client.callTool({ name: "read_page", arguments: { slug: SLUG } });

    // The load-bearing pair: the ambient Stack REALLY has this page, so a fallback
    // would return its body instead of a refusal.
    expect(textOf(result)).not.toContain(ROW_BODY);
    expect(textOf(result)).toContain("stackId");
  });

  it("writes nothing into the bound Stack or the Stack a later call names", async () => {
    const { stack: bound } = fixture();
    if (!bound.harness.reachable) return;
    const named = await createProbeStack("stack-arg-required-named");
    try {
      if (!named.harness.reachable) return;
      await seedNamedPage(named);
      const before = {
        bound: await countsOf(bound.harness, bound.harness.stackId),
        named: await countsOf(named.harness, named.harness.stackId),
      };

      // Every nameless call is refused by the schema before a handler can run.
      for (const { name, args } of MISSING_STACK_CALLS) {
        const refused = await client.callTool({ name, arguments: args });
        expect(refused.isError).toBe(true);
      }

      // A call that DOES name a Stack this test owns. It reaches THAT Stack's page —
      // so the seam really resolves the argument — and still writes to neither Stack.
      const served = await client.callTool({
        name: "read_page",
        arguments: { slug: NAMED_SLUG, stackId: named.harness.stackId },
      });
      expect(served.isError).toBeFalsy();
      expect(textOf(served)).toContain(NAMED_BODY);

      expect({
        bound: await countsOf(bound.harness, bound.harness.stackId),
        named: await countsOf(named.harness, named.harness.stackId),
      }).toEqual(before);
    } finally {
      await named.harness.cleanup();
    }
  });

  it("serves the same read_page call once the Stack is passed explicitly", async () => {
    const { stack } = fixture();
    if (!stack.harness.reachable) return;
    await seedAmbientPage(fixture());

    const result = await client.callTool({
      name: "read_page",
      arguments: { slug: SLUG, stackId: stack.harness.stackId },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(ROW_BODY);
  });
});
