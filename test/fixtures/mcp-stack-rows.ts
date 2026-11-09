/**
 * @file test/fixtures/mcp-stack-rows.ts
 * @description The arrangements the required-Stack MCP suites repeat: one page stored
 * as a ROW, a journal read back out of the Stack itself, the row-only provider stub, the
 * frozen schema-refusal text, and a `tools/call` that goes over a real in-memory
 * transport.
 *
 * ## Why these are shared rather than copied per suite
 *
 * Every suite that checks "this tool answered from the Stack the caller NAMED" needs the
 * same four things, and each copy is a chance to measure something else:
 *
 *   - the page must be a row written through `createPageWriteSink`, the sink a compile
 *     uses. A `wiki/concepts/<slug>.md` file would be found either way, so a silent
 *     fallback to disk would pass;
 *   - the journal must be read on its OWN transaction, so the tenant bind is the Stack
 *     being inspected rather than the one the process happens to serve;
 *   - the provider must be stubbed at the LLM boundary only — retrieval, the registry
 *     seam, the tenant bind and the row reads stay production code, because they are
 *     what those suites measure;
 *   - a refusal must be asserted against the text a CLIENT sees, which is the SDK's
 *     validation message and the validator's argument name.
 *
 * ## Why the refusal helpers are not just a string constant
 *
 * The prefix belongs to the SDK (`MCP error -32602: Input validation error: …`) and the
 * tail to the validator (`… at stackId`). A caller that switches on the message needs
 * both halves stable, so the pair is frozen in one place instead of being retyped into
 * the two suites that assert it.
 */

import { expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDimensionsDatabase } from "../../packages/wiki/src/dimensions/activation.js";
import { readJournalEntries } from "../../packages/wiki/src/dimensions/wiki/activity-log-store.js";
import type { JournalEntry } from "../../packages/wiki/src/dimensions/wiki/activity-log-store.js";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import type { KgPostgresHarness } from "./kg-postgres.js";

/** One tool call that omits the required Stack argument. */
export interface RefusedCall {
  /** Registered tool name. */
  readonly name: string;
  /** The other arguments that tool needs. */
  readonly args: Record<string, unknown>;
}

/**
 * Store one concept page as a ROW in the Stack `harness` owns.
 *
 * Written through the production sink, so a seeded row cannot differ in shape from a row
 * the product wrote. `body` includes its own frontmatter, as the compile writes it.
 *
 * @param harness - The Stack that owns the page, and its database handle.
 * @param slug - Page slug inside the `concepts` namespace.
 * @param body - Full page markdown, frontmatter included.
 */
export async function seedConceptPage(
  harness: KgPostgresHarness,
  slug: string,
  body: string,
): Promise<void> {
  await createPageWriteSink(harness.db, harness.stackId)({ directory: "concepts", slug, body });
}

/**
 * The journal entries `stackId` holds, read on a handle this call opens and closes.
 *
 * The read happens inside `readJournalEntries`' own transaction, which binds the tenant
 * to `stackId` — so the inspection is of the Stack asked about, never of whichever Stack
 * the process is currently bound to.
 *
 * @param stackId - The Stack whose journal to read.
 * @returns Its entries, oldest first.
 */
export async function journalEntries(stackId: string): Promise<JournalEntry[]> {
  const handle = createDimensionsDatabase(process.env);
  try {
    return await readJournalEntries(handle.db, stackId);
  } finally {
    await handle.close();
  }
}

/**
 * The journal DESCRIPTIONS `stackId` holds, oldest first.
 *
 * The description is what a query or a saved answer records, so it is the field the
 * isolation suites compare.
 *
 * @param stackId - The Stack whose journal to read.
 * @returns Entry descriptions, oldest first.
 */
export async function journalDescriptions(stackId: string): Promise<string[]> {
  return (await journalEntries(stackId)).map((entry) => entry.description);
}

/**
 * A `vi.mock` module for `../src/utils/llm.js` that answers from ROWS.
 *
 * Two calls reach the stubbed boundary: the selector (the request carries `tools`) and
 * the answer itself. The selector picks `pageId` — a page that exists only as a row, so
 * a disk read cannot produce this answer — and every other call returns
 * `ANSWER_FROM_ROWS`, which is what an answer built from those rows contains.
 *
 * Shared so the suites that assert a row-backed answer cannot drift into two different
 * fakes for the same boundary. Passed to `vi.mock` exactly like
 * `echoCallClaudeModule()` in `typed-grounding.ts`.
 *
 * @param pageId - Qualified page id the selector reports as picked.
 * @returns The mocked module shape.
 */
export function rowOnlyProviderModule(pageId: string): { callClaude: ReturnType<typeof vi.fn> } {
  return {
    callClaude: vi.fn(async (options: { tools?: unknown }) =>
      options.tools
        ? JSON.stringify({ pages: [pageId], reasoning: "the row page" })
        : "ANSWER_FROM_ROWS",
    ),
  };
}

/**
 * What an MCP client prints when the SDK rejects a call missing `stackId`.
 *
 * Frozen deliberately: the prefix is the SDK's and the tail is the validator's, naming
 * the argument. A caller switching on the text needs both halves stable.
 *
 * @param toolName - Tool the refused call named.
 * @returns The exact refusal text.
 */
export function refusalText(toolName: string): string {
  return (
    `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ` +
    "Invalid input: expected string, received undefined at stackId"
  );
}

/** Join the text blocks of a tool envelope, which is all a client can branch on. */
export function textOf(result: CallToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Assert one nameless call is refused by the schema, with the exact text a client sees.
 *
 * The call goes through a real `Client`, not through the registered handler, because the
 * refusal under test IS the SDK's validation of the emitted schema — invoking the
 * handler directly would skip validation and keep passing after the argument became
 * required.
 *
 * @param client - Client connected to the server under test.
 * @param call - The tool and the arguments that omit `stackId`.
 */
export async function expectRefusedNamingStackId(
  client: Client,
  call: RefusedCall,
): Promise<void> {
  const result = await client.callTool({ name: call.name, arguments: call.args });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe(refusalText(call.name));
}

/**
 * Drive every nameless call and assert each one was refused before a handler could run.
 *
 * Used by the write-check cases, where a per-tool refusal is re-asserted so the case
 * cannot pass against a handler that half-ran and wrote nothing.
 *
 * @param client - Client connected to the server under test.
 * @param calls - The tools that omit `stackId`.
 */
export async function expectNamelessCallsRefused(
  client: Client,
  calls: readonly RefusedCall[],
): Promise<void> {
  for (const { name, args } of calls) {
    const refused = await client.callTool({ name, arguments: args });
    expect(refused.isError).toBe(true);
  }
}

/**
 * Call one registered tool the way a client does — `tools/call` over a real transport —
 * and decode the JSON payload it answered with.
 *
 * A parity or payload pin must meet the tool the same way a caller does, which is why it
 * cannot use the in-process handler shortcut in `mcp-test-env.ts`.
 *
 * @param server - Server with the tools registered.
 * @param name - Registered tool name.
 * @param args - Arguments for the call, including the required Stack.
 * @param clientName - Client name recorded on the handshake, so a failure names its suite.
 * @returns The decoded JSON payload the handler answered with.
 */
export async function callToolPayload(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  clientName: string,
): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    return JSON.parse(blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));
  } finally {
    await client.close();
    await server.close();
  }
}
