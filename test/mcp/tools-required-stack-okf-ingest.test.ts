/**
 * @file test/mcp/tools-required-stack-okf-ingest.test.ts
 * @description S1-S3 for the three wiki tools that used to take no Stack at all:
 * `export_okf`, `import_okf` and `ingest_source`.
 *
 * ## Why these three needed their own suite
 *
 * The other Stack-scoped tools already had a schema argument; these three resolved a
 * backend from the ambient environment and nothing else. `export_okf` read pages
 * through `withRawPageSource(root, process.env, …)`, `import_okf` wrote through
 * `withPageSeams(process.env, …)` and `ingest_source` called
 * `resolveStackForCommand(db, env)`, which PROVISIONS a default Stack when none is
 * configured. A caller could therefore get one tenant's rows back while believing it
 * had asked about no tenant in particular.
 *
 * ## Why the calls go over the transport and not through the handler
 *
 * S1 and S2 are properties of the emitted schema and of the SDK's validation of it.
 * `callTool()` in `test/fixtures/mcp-test-env.ts` reaches into `_registeredTools` and
 * invokes the handler directly, which skips validation entirely — a suite built on it
 * would keep passing after the argument became required. A real `Client` over
 * `InMemoryTransport` is the path an agent takes, so both rules are asserted there.
 *
 * ## Why the bound Stack is REAL and seeded
 *
 * A deployment that serves one Stack still exports `AKS_STACK_ID`, and that value is
 * what the old code substituted when the argument was missing. Every case here runs
 * with a real Stack bound and holding a page, so a surviving fallback cannot pass by
 * accident: it would answer with that row instead of refusing.
 *
 * ## Why the writes are counted
 *
 * "It refused" is not enough. A refusal that still staged candidates or wrote a bundle
 * leaves artifacts behind while telling the caller nothing happened, so the row counts
 * and the filesystem are compared on both sides.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerOkfTools } from "../../src/mcp/okf-tools.js";
import { registerWikiTools } from "../../src/mcp/tools.js";
import { STACK_ARG_REQUIRED_NOTE } from "../../src/mcp/stack-arg.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import { withRowsStack } from "../fixtures/rows-only-stack.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** The three tools under test. */
const TOOLS = ["export_okf", "import_okf", "ingest_source"] as const;

/** Slug of the page only rows can reach. */
const SLUG = "stack-only";

/** Body reachable ONLY through a Stack, so a file fallback cannot serve it. */
const ROW_BODY = "ROW_BODY_reachable_only_through_the_stack_argument";

/** One concept page as `wiki.pages` stores it. */
const ROW_PAGE = `---\ntitle: Stack Only\nsummary: row\n---\n\n${ROW_BODY}\n`;

/** Body long enough to clear the ingest minimum-content check. */
const SOURCE_BODY = "# Sample\n\nLong enough body to satisfy the minimum source character threshold for ingest.";

/** The subset of a `tools/list` entry this file reads. */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema: { required?: string[] };
}

/** What a case receives once the server and its Stack are up. */
interface Session {
  readonly client: Client;
  readonly root: string;
  readonly harness: KgPostgresHarness;
  /** Every registered tool from a real `tools/list` handshake, keyed by name. */
  list(): Promise<Map<string, ListedTool>>;
}

/**
 * What an MCP client prints when the SDK rejects a call missing `stackId`.
 *
 * Frozen deliberately: the prefix is the SDK's and the tail is the validator's,
 * naming the argument. A caller switching on this text needs both halves stable.
 *
 * @param toolName - Tool the refused call named.
 * @returns The exact refusal text.
 */
function refusalText(toolName: string): string {
  return (
    `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ` +
    "Invalid input: expected string, received undefined at stackId"
  );
}

/** Join the text blocks of a tool envelope, which is all a client can branch on. */
function textOf(result: CallToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("");
}

/** Read the JSON payload a tool returned via `jsonResult`. */
function payloadOf(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent as { result: Record<string, unknown> }).result;
}

/**
 * Run `body` against a server that registers the wiki AND the OKF tools.
 *
 * `buildServer` deliberately omits the OKF tools, so this suite builds its own
 * instance: the whole point is one handshake that covers all three tools at once.
 *
 * @param label - Short suite label recorded on the provisioned Stack.
 * @param body - Work to run with the server connected over the in-memory transport.
 */
async function withTools(label: string, body: (session: Session) => Promise<void>): Promise<void> {
  await withRowsStack(label, async ({ root, harness }) => {
    const server = new McpServer({ name: "required-stack", version: "0" });
    registerWikiTools(server, root);
    registerOkfTools(server, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "required-stack", version: "0" });
    await client.connect(clientTransport);
    const list = async (): Promise<Map<string, ListedTool>> =>
      new Map((await client.listTools()).tools.map((tool) => [tool.name, tool as ListedTool]));
    try {
      await body({ client, root, harness, list });
    } finally {
      await client.close();
      await server.close();
    }
  });
}

/** One Stack's row counts: everything a refused OKF/ingest call could have written. */
interface StackCounts {
  pages: number;
  /** `wiki.derived_artifact` — the index/MOC renders a compile regenerates. */
  artifacts: number;
  /** `wiki.review_candidates` — where an OKF import stages. */
  candidates: number;
  /** `wiki.source_documents` — where an ingest lands. */
  sources: number;
}

/** The Stack-scoped tables a refused call must leave byte-identical, by counter name. */
const COUNTED_TABLES: ReadonlyArray<[keyof StackCounts, string]> = [
  ["pages", "wiki.pages"],
  ["artifacts", "wiki.derived_artifact"],
  ["candidates", "wiki.review_candidates"],
  ["sources", "wiki.source_documents"],
];

/**
 * Every Stack's row counts, keyed by Stack id, zero-filled where a Stack holds nothing.
 *
 * Per Stack rather than one whole-table total: the total it replaced compared
 * `{ stacks: 4003, pages: 598 }` against `{ stacks: 4004, pages: 596 }` and read a
 * sibling suite's fixture as a write of ours. Keying the same measurement to the
 * tenant that owns the rows removes that noise — see {@link expectNoWrites} for how
 * far the comparison can honestly go.
 *
 * @param harness - The suite's database handle.
 * @returns Stack id → its counts, for every Stack with at least one row.
 */
async function stacksWithCounts(harness: KgPostgresHarness): Promise<Map<string, StackCounts>> {
  const snapshot = new Map<string, StackCounts>();
  for (const [key, table] of COUNTED_TABLES) {
    const rows = await harness.db.execute(
      `select stack_id::text as stack_id, count(*)::int as n from ${table} group by 1`,
    );
    for (const row of rows as Array<{ stack_id: string; n: number }>) {
      const counts = snapshot.get(row.stack_id) ?? { pages: 0, artifacts: 0, candidates: 0, sources: 0 };
      snapshot.set(row.stack_id, { ...counts, [key]: Number(row.n) });
    }
  }
  return snapshot;
}

/**
 * Assert the refused calls moved none of `bound`'s rows.
 *
 * ## Why the BOUND Stack is the detector
 *
 * These three calls name no Stack, so the env-substituting fallback under test had
 * exactly ONE reachable tenant: `process.env.AKS_STACK_ID`, the Stack the deployment
 * serves — `bound` here, owned exclusively by this suite's fixture. Asserting it is
 * untouched IS the cross-tenant write detector, and it still fails if a fallback
 * returns.
 *
 * ## Why not "every Stack present in both snapshots"
 *
 * Tried, and not race-proof in a shared database: a sibling suite writing to ITS OWN
 * Stack between the two snapshots is indistinguishable from a cross-tenant write by
 * this call. Measured — three consecutive runs of this suite alongside its siblings,
 * each failing on a different foreign Stack's own `pages`/`sources`. Counting a Stack
 * this process can never reach does not strengthen the assertion; it makes the gate
 * untrustworthy. A global `stacks` count is the 4003-versus-4004 flake itself.
 *
 * @param before - Snapshot taken before the refused calls.
 * @param after - Snapshot taken after them.
 * @param bound - The Stack the deployment serves, and the only tenant a fallback could reach.
 */
function expectNoWrites(
  before: Map<string, StackCounts>,
  after: Map<string, StackCounts>,
  bound: string,
): void {
  const empty: StackCounts = { pages: 0, artifacts: 0, candidates: 0, sources: 0 };
  expect(after.get(bound) ?? empty).toEqual(before.get(bound) ?? empty);
  // A refused call cannot remove the Stack either: it is still there afterwards.
  expect(after.has(bound)).toBe(before.has(bound));
}

/** How many source documents `stackId` holds. */
async function sourcesIn(harness: KgPostgresHarness, stackId: string): Promise<number> {
  const [row] = await harness.db.execute(
    `select count(*)::int as n from wiki.source_documents where stack_id = '${stackId}'`,
  );
  return Number((row as { n: number }).n);
}

/** Store one page as a row on `stackId`. */
async function seedRow(harness: KgPostgresHarness, stackId: string, slug: string = SLUG): Promise<void> {
  await createPageWriteSink(harness.db, stackId)({
    directory: "concepts",
    slug,
    body: ROW_PAGE.replace("Stack Only", slug),
  });
}

/** Write a foreign OKF bundle with one valid concept doc under `<root>/kb`. */
async function seedBundle(root: string): Promise<void> {
  await mkdir(path.join(root, "kb/concepts"), { recursive: true });
  await writeFile(path.join(root, "kb/concepts/a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n", "utf-8");
}

/** The three calls that omit `stackId`, each with the other arguments it needs. */
const MISSING_STACK_CALLS: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  { name: "export_okf", args: {} },
  { name: "import_okf", args: { dir: "kb" } },
  { name: "ingest_source", args: { source: "fixture.txt" } },
];

describe("S1: the OKF and ingest tools declare stackId required", () => {
  it("lists stackId in the required array of all three tools", async () => {
    await withTools("req-okf-s1", async ({ list }) => {
      const listed = await list();
      for (const name of TOOLS) {
        expect(listed.get(name)?.inputSchema.required ?? [], `${name} must require stackId`).toContain("stackId");
      }
    });
  });

  it("records the shared no-fallback rule in every tool description", async () => {
    await withTools("req-okf-s1-note", async ({ list }) => {
      const listed = await list();
      for (const name of TOOLS) {
        expect(listed.get(name)?.description ?? "", `${name} must state the rule`).toContain(STACK_ARG_REQUIRED_NOTE);
      }
    });
  });
});

describe("S2: a call with no stackId is refused and touches nothing", () => {
  it.each(MISSING_STACK_CALLS)("$name is refused, naming stackId", async ({ name, args }) => {
    await withTools(`req-okf-${name}`, async ({ client }) => {
      const result = await client.callTool({ name, arguments: args });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(refusalText(name));
    });
  });

  it("leaves rows, bundles and candidates untouched", async () => {
    await withTools("req-okf-s2-writes", async ({ client, root, harness }) => {
      await seedBundle(root);
      const before = await stacksWithCounts(harness);

      for (const { name, args } of MISSING_STACK_CALLS) await client.callTool({ name, arguments: args });

      // Per Stack, so a sibling suite's fixture cannot look like a write of ours.
      expectNoWrites(before, await stacksWithCounts(harness), harness.stackId);
      // The refusal is what makes "nothing was written" credible: the SDK rejected the
      // call before the handler ran, so no fallback and no default-Stack provisioning
      // could even start. Pinned per tool above; re-asserted here so this case cannot
      // pass against a handler that half-ran and wrote nothing.
      for (const { name, args } of MISSING_STACK_CALLS) {
        const refused = await client.callTool({ name, arguments: args });
        expect(refused.isError).toBe(true);
      }
      expect(existsSync(path.join(root, "dist"))).toBe(false);
      expect(existsSync(path.join(root, ".llmwiki", "candidates"))).toBe(false);
    });
  });

  it("does not export the page the deployment is bound to", async () => {
    await withTools("req-okf-s2-ambient", async ({ client, root, harness }) => {
      await seedRow(harness, harness.stackId);

      const result = await client.callTool({ name: "export_okf", arguments: {} });

      // The bound Stack REALLY holds this page, so a surviving fallback would have
      // written a bundle instead of refusing.
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("stackId");
      expect(existsSync(path.join(root, "dist"))).toBe(false);
    });
  });
});

describe("a call that names the Stack explicitly", () => {
  it("export_okf bundles the named Stack's rows, not the bound Stack's", async () => {
    const target = await createProbeStack("req-okf-export-target");
    try {
      if (!target.harness.reachable) return;
      await withTools("req-okf-export-ok", async ({ client, root, harness }) => {
        await seedRow(harness, harness.stackId, "bound-only");
        await seedRow(target.harness, target.harness.stackId, "named-only");

        const result = await client.callTool({ name: "export_okf", arguments: { stackId: target.harness.stackId } });
        const bundle = path.join(root, "dist/exports/okf");

        expect(result.isError).toBeFalsy();
        expect(existsSync(path.join(bundle, "index.md"))).toBe(true);
        expect(existsSync(path.join(bundle, "concepts/named-only.md"))).toBe(true);
        expect(existsSync(path.join(bundle, "concepts/bound-only.md"))).toBe(false);
      });
    } finally {
      await target.harness.cleanup();
    }
  });

  it("refuses a Stack id that does not exist instead of falling back", async () => {
    await withTools("req-okf-unknown-stack", async ({ client, root }) => {
      await seedBundle(root);

      const result = await client.callTool({
        name: "import_okf",
        arguments: { dir: "kb", stackId: randomUUID() },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No Stack");
    });
  });

  it("import_okf stages the bundle for the named Stack", async () => {
    await withTools("req-okf-import-ok", async ({ client, root, harness }) => {
      await seedBundle(root);

      const result = await client.callTool({
        name: "import_okf",
        arguments: { dir: "kb", stackId: harness.stackId },
      });

      expect(result.isError).toBeFalsy();
      expect(payloadOf(result)).toMatchObject({ mode: "staged", imported: 1 });
    });
  });

  it("ingest_source writes into the named Stack, not the bound one", async () => {
    const target = await createProbeStack("req-ingest-target");
    try {
      if (!target.harness.reachable) return;
      await withTools("req-ingest-ok", async ({ client, root, harness }) => {
        const file = path.join(root, "note.txt");
        await writeFile(file, SOURCE_BODY, "utf-8");

        const result = await client.callTool({
          name: "ingest_source",
          arguments: { source: file, stackId: target.harness.stackId },
        });

        expect(result.isError).toBeFalsy();
        expect(await sourcesIn(target.harness, target.harness.stackId)).toBe(1);
        expect(await sourcesIn(harness, harness.stackId)).toBe(0);
      });
    } finally {
      await target.harness.cleanup();
    }
  });
});
