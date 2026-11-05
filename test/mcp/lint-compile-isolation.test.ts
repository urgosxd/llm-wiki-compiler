/**
 * @file test/mcp/lint-compile-isolation.test.ts
 * @description `lint_wiki` and `compile_wiki` answer from the Stack the caller NAMED.
 *
 * ## The condition this pins
 *
 * Both tools resolve most of their work from the environment they are handed, and both
 * used to leave one reader on the ambient `process.env`:
 *
 *   - `lint_wiki`: the freshness snapshot (`buildProjectFreshnessSnapshot`) was built
 *     with no environment, so the `stale-page` rule compared the NAMED Stack's pages
 *     against the AMBIENT deployment's sources. Measured before the fix: a Stack whose
 *     page is genuinely stale produced ZERO stale findings when the process was bound
 *     to another Stack, while `wiki_status` — which does receive the request env —
 *     reported `stalePages: ["stale-page"]` for the same rows.
 *   - `compile_wiki`: the journal write (`appendLog`), the derived artifacts
 *     (`regenerateIndices`) and the database handle (`createDimensionsDatabase`) were
 *     built from the ambient environment, so a compile naming Stack A journalled into
 *     whichever Stack the process happened to serve. A cross-tenant WRITE is worse than
 *     a wrong read: it survives the call.
 *
 * ## Why every case asserts BOTH sides
 *
 * "The finding is in A" alone would pass if the reader consulted both Stacks; "it is
 * not in B" alone would pass if it consulted neither. Only the pair shows the read or
 * write was ROUTED. The positive control — ambient naming the same Stack — additionally
 * proves the fix did not change the payload of the call that already worked.
 *
 * ## Why the tools are driven through a real client
 *
 * The defect lived in the wiring between the registered tool and the reader, so a
 * helper that builds its own environment would pass while that wiring stayed broken.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readJournalEntries } from "../../src/dimensions/wiki/activity-log-store.js";
import {
  hashSourceContent,
  saveSourceDocument,
  stableSourceContent,
} from "../../src/dimensions/wiki/source-documents-store.js";
import { writeWikiStateToRows } from "../../src/dimensions/wiki/wiki-state-source.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { compileAndReport } from "../../src/compiler/index.js";
import type { WikiState } from "../../src/utils/types.js";
import { buildServer } from "../fixtures/mcp-test-env.js";
import { callToolPayload, seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { provisionStack, type ProvisionedStack } from "../fixtures/stack-harness.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** A database URL nothing answers on, for the "deployment is configured elsewhere" case. */
const UNREACHABLE_DATABASE_URL = "postgresql://aks:aks@127.0.0.1:1/aks";

/** Identity whose stored document still matches the compiled hash. */
const FRESH_IDENTITY = "https://isolation.test/fresh";
/** Identity whose document changed after the recorded hash, making its page stale. */
const STALE_IDENTITY = "https://isolation.test/stale";

/** The document text the Stack stores for one identity. */
function documentFor(identity: string): string {
  return `${identity} body\n`;
}

/** A page body the compiler could have written, in the shape the linter reads. */
function pageBody(title: string): string {
  return (
    `---\ntitle: ${title}\nsummary: ${title} summary\n---\n\n` +
    "Body long enough that the empty-page rule has nothing to say.\n"
  );
}

/**
 * Seed one Stack with a fresh page and a page whose source moved on.
 *
 * Everything lives in ROWS: the fixture project has no `wiki/` and no `sources/`, so a
 * disk read cannot answer in place of the Stack the caller named.
 *
 * @param stack - The provisioned Stack to seed.
 */
async function seedStacks(stack: ProvisionedStack): Promise<void> {
  const { db, stackId } = stack.harness;
  await seedConceptPage(stack.harness, "fresh-page", pageBody("Fresh"));
  await seedConceptPage(stack.harness, "stale-page", pageBody("Stale"));
  for (const identity of [FRESH_IDENTITY, STALE_IDENTITY]) {
    await saveSourceDocument(db, stackId, {
      title: identity,
      source: identity,
      document: documentFor(identity),
    });
  }
  const state: WikiState = {
    version: 2,
    indexHash: "",
    sources: {
      [FRESH_IDENTITY]: {
        hash: hashSourceContent(stableSourceContent(documentFor(FRESH_IDENTITY))),
        concepts: ["fresh-page"],
        compiledAt: "2024-01-03T00:00:00.000Z",
        source: FRESH_IDENTITY,
      },
      // A hash from an earlier run: the document on record no longer matches it.
      [STALE_IDENTITY]: {
        hash: "hash-recorded-by-an-earlier-compile",
        concepts: ["stale-page"],
        compiledAt: "2024-01-03T00:00:00.000Z",
        source: STALE_IDENTITY,
      },
    },
  };
  await writeWikiStateToRows(db, stackId, state);
}

/** The lint finding shape the assertions read. */
interface Finding {
  file: string;
  message: string;
  rule: string;
  severity: string;
}

/** The lint summary fields a caller can branch on. */
interface LintPayload {
  errors: number;
  warnings: number;
  info: number;
  results: Finding[];
}

let named: ProvisionedStack;
let ambient: ProvisionedStack;
let root: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  named = await provisionStack("isolation-named");
  ambient = await provisionStack("isolation-ambient");
  root = await scratchProjectRoot("isolation-");
  savedEnv = { ...process.env };
});

afterEach(async () => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  await named.release();
  await ambient.release();
  await rm(root, { recursive: true, force: true });
});

describe("lint_wiki reads the Stack it names", () => {
  it("reports the named Stack's stale page while the process serves another", async () => {
    if (!named.harness.reachable) return;
    await seedStacks(named);
    // The process is bound to the OTHER Stack, exactly as a multi-tenant host is.
    process.env.AKS_STACK_ID = ambient.harness.stackId;

    const payload = await lintOf(buildServer(root), named.harness.stackId);

    // The finding `wiki_status` already reports for these same rows, through `lint`.
    const stale = payload.results.filter((finding) => finding.rule === "stale-page");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.file).toContain("stale-page");
    expect(payload.warnings).toBe(payload.results.filter((r) => r.severity === "warning").length);
  }, 60_000);

  it("answers the same payload when the ambient environment names the same Stack", async () => {
    if (!named.harness.reachable) return;
    await seedStacks(named);
    process.env.AKS_STACK_ID = named.harness.stackId;
    const bound = await lintOf(buildServer(root), named.harness.stackId);

    process.env.AKS_STACK_ID = ambient.harness.stackId;
    const mixed = await lintOf(buildServer(root), named.harness.stackId);

    // The control: binding the process to the Stack the call names changes nothing...
    expect(bound.results).toContainEqual(expect.objectContaining({ rule: "stale-page" }));
    expect(mixed).toEqual(bound);
    // ...and the ambient Stack's rows were never the subject of either run.
    expect(await rowCount(ambient, "wiki.pages")).toBe(0);
  }, 60_000);
});

/** Call `lint_wiki` naming `stackId`, over a real client and transport. */
async function lintOf(server: McpServer, stackId: string): Promise<LintPayload> {
  return (await callJson(server, "lint_wiki", { stackId })) as LintPayload;
}

describe("compile_wiki writes to the Stack it names", () => {
  it("journals the compile for the named Stack, not the ambient one", async () => {
    const run = await compileNamedWhileAmbient();
    if (run === undefined) return;

    // The run really compiled: a refusal or an early return would leave both journals
    // empty and make the assertions below pass for the wrong reason.
    expect(run).toMatchObject({ compiled: 1, errors: [] });
    // Both sides: the entry is in the Stack the call named...
    expect(await journalOf(named)).toContain("compile");
    // ...and NOT in the one the deployment serves, which is the cross-tenant write.
    expect(await journalOf(ambient)).toEqual([]);
    // The rows path answered, so no file journal may stand in for a lost row.
    expect(existsSync(path.join(root, "log.md"))).toBe(false);
  }, 120_000);

  it("records the compile state for the named Stack only", async () => {
    const run = await compileNamedWhileAmbient();
    if (run === undefined) return;

    expect(run).toMatchObject({ compiled: 1 });
    expect(await rowCount(named, "wiki.source_compile_state")).toBe(1);
    expect(await rowCount(ambient, "wiki.source_compile_state")).toBe(0);
  }, 120_000);

  it("opens the run's database, not the one the deployment is configured with", async () => {
    if (!named.harness.reachable) return;
    await seedSource(named);
    stubProvider();
    // The run's environment: the Stack it names, on the database the harness owns.
    const runEnv = { ...process.env, AKS_STACK_ID: named.harness.stackId };
    // The deployment this process serves is configured with a database NOTHING answers
    // on, and binds no Stack. `compileAndReport` used to build its handle from
    // `process.env`, so this exact call died with `connect ECONNREFUSED 127.0.0.1:1`
    // before the run's environment was threaded through.
    process.env.AKS_DATABASE_URL = UNREACHABLE_DATABASE_URL;

    const result = await compileAndReport(root, { env: runEnv });

    expect(result).toMatchObject({ compiled: 1, errors: [] });
    // Both sides: the named Stack holds the compile...
    expect(await journalOf(named)).toContain("compile");
    expect(await rowCount(named, "wiki.source_compile_state")).toBe(1);
    // ...and the ambient deployment got nothing on EITHER backend — no rows in another
    // Stack, and no file journal, which is what a file-backed deployment would write.
    expect(await journalOf(ambient)).toEqual([]);
    expect(await rowCount(ambient, "wiki.source_compile_state")).toBe(0);
    expect(existsSync(path.join(root, "log.md"))).toBe(false);
  }, 120_000);
});

/**
 * Seed the source, stub the provider and compile the NAMED Stack while the process is
 * bound to the OTHER one.
 *
 * Both compile cases arrange exactly this and differ only in what they assert, so the
 * arrangement lives here: if the two copies drifted, one of them would stop exercising
 * the cross-tenant write the other still measures.
 *
 * @returns The compile payload, or `undefined` when there is no test database.
 */
async function compileNamedWhileAmbient(): Promise<unknown | undefined> {
  if (!named.harness.reachable) return undefined;
  await seedSource(named);
  stubProvider();
  // The process is bound to the OTHER Stack: before the fix the compile ran for the
  // named Stack and journalled into this one.
  process.env.AKS_STACK_ID = ambient.harness.stackId;
  return callJson(buildServer(root), "compile_wiki", { stackId: named.harness.stackId });
}

/**
 * Seed the one source document a compile turns into a page.
 *
 * A row, not a file: with a Stack configured the compile's corpus IS the Stack's
 * `source_documents` rows, so a file under `sources/` would be invisible and the run
 * would report "nothing to compile" — an empty diff that proves nothing.
 *
 * @param stack - The Stack the compile will name.
 */
async function seedSource(stack: ProvisionedStack): Promise<void> {
  await saveSourceDocument(stack.harness.db, stack.harness.stackId, {
    title: "Sample Topic",
    source: "https://isolation.test/sample",
    document: "# Sample Topic\n\nSome source content about a topic.\n",
  });
}

/**
 * Stub only the LLM boundary: extraction and the generated page body.
 *
 * Everything the assertions measure — change detection, the page write sink, the
 * compile state, the journal write — stays production code.
 */
function stubProvider(): void {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
    JSON.stringify({ concepts: [{ concept: "Sample Topic", summary: "S.", is_new: true }] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(
    "Body content for the topic. ^[sample.md]",
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/**
 * The operation tags `stack` holds in its journal, in append order.
 *
 * Read through the harness handle rather than one built from `process.env`: a case
 * below points the deployment's `AKS_DATABASE_URL` at a database nothing answers on,
 * and the inspection must not inherit that.
 *
 * @param stack - The Stack to read.
 * @returns Its journal's operation tags, oldest first.
 */
async function journalOf(stack: ProvisionedStack): Promise<string[]> {
  const entries = await readJournalEntries(stack.harness.db, stack.harness.stackId);
  return entries.map((entry) => entry.operation);
}

/**
 * Call one registered tool the way a client does and decode its JSON payload.
 *
 * @param server - Server with the wiki tools registered.
 * @param name - Registered tool name.
 * @param args - Arguments for the call, including the required Stack.
 * @returns The decoded payload the handler answered with.
 */
async function callJson(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return callToolPayload(server, name, args, "lint-compile-isolation");
}

/**
 * How many rows `table` holds for `stack`.
 *
 * Filtered by `stack_id` in SQL rather than relying on the tenant policy: the test role
 * owns these tables, so `set_config('app.stack_id', …)` does NOT narrow a plain count
 * and an unscoped query silently returns every Stack's rows.
 *
 * @param stack - The Stack to count.
 * @param table - Stack-scoped table, as the database names it.
 * @returns The row count owned by `stack`.
 */
async function rowCount(stack: ProvisionedStack, table: string): Promise<number> {
  const [row] = await stack.harness.db.execute(
    `select count(*)::int as n from ${table} where stack_id = '${stack.harness.stackId}'`,
  );
  return Number((row as { n: number }).n);
}
