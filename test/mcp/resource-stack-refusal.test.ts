/**
 * @file test/mcp/resource-stack-refusal.test.ts
 * @description S5: a Stack-scoped `llmwiki://` resource refuses BY NAME instead of
 * resolving a Stack from the process environment.
 *
 * ## Why the environment is loaded with a REAL Stack
 *
 * The defect is not "a resource with no Stack refuses" — the old code refused that too,
 * once nothing was provisioned for it. It is that a resource answered from whichever
 * Stack the process happened to name, silently and indistinguishably from a deliberate
 * request. So every refusing case below binds `AKS_STACK_ID` to a provisioned Stack that
 * really holds a page, and asserts the read refuses RATHER THAN returning that page. A
 * case that only proved a refusal would pass against the old code.
 *
 * ## Why the refusal is driven through the registered callback
 *
 * This surface has no `isError` envelope: the SDK turns a thrown error into the JSON-RPC
 * error a resource read answers with (`server/mcp.js` returns `readCallback`'s value and
 * propagates a throw), which is the same channel `Page not found` already uses. So the
 * callback IS the public interface here, and the table of registered callbacks is what a
 * client reaches.
 *
 * ## What must NOT change
 *
 * Two populations are asserted as preserved rather than fixed. With NO database
 * configured, every Stack-scoped resource keeps reading this checkout's files byte for
 * byte (S7). And the resources that never consulted a database at all — `index`,
 * `sources`, `eval/*` — keep answering on a database-configured run, because refusing
 * them would invent a failure the old code did not have.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { buildServer } from "../fixtures/mcp-test-env.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { usePerCaseFileMode, withFileMode } from "../fixtures/file-mode.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";
import { writePage } from "../fixtures/write-page.js";

// A mixed file: the refusing cases need the database the worker was seeded with, the S7
// case declares its absence for itself.
usePerCaseFileMode();

/** The slug BOTH backends carry, so a wrong backend still finds something to answer with. */
const SLUG = "shared";
/** The body ONLY the Stack's row holds: a resource that answers with it read the ambient Stack. */
const ROW_BODY = "BODY_STORED_IN_THE_AMBIENT_STACK";
/** The body ONLY this checkout's file holds. */
const FILE_BODY = "BODY_READ_FROM_THE_CHECKOUT";
/** The reason the refusal must give: the SHAPE of the interface, not the caller's omission. */
const SHAPE_CLAUSE = "a resource URI cannot carry a Stack";
/** The remedy it must name, because a tool call is the surface that CAN carry one. */
const TOOL_CLAUSE = "Call a tool that takes a stackId argument instead";

/** One static resource's read callback, as the SDK holds it. */
type StaticRead = (uri: URL) => Promise<{ contents: Array<{ text: string }> }>;

/** One resource payload as these cases read it. */
type ResourcePayload = { contents: Array<{ text: string }> };

/** One template's list and read callbacks, as the SDK holds it. */
interface TemplateEntry {
  readonly resourceTemplate: {
    listCallback?: () => Promise<{ resources: Array<{ uri: string; name: string }> }>;
  };
  readonly readCallback: (uri: URL, variables: Record<string, unknown>) => Promise<ResourcePayload>;
}

/** The registered static resource `uri`, refusing to pretend it does not exist. */
function staticRead(server: McpServer, uri: string): StaticRead {
  const map = (
    server as unknown as { _registeredResources: Record<string, { readCallback: StaticRead }> }
  )._registeredResources;
  const entry = map[uri];
  if (entry === undefined) throw new Error(`${uri} is not registered`);
  return entry.readCallback;
}

/** The registered template called `name`. */
function templateEntry(server: McpServer, name: string): TemplateEntry {
  const map = (
    server as unknown as { _registeredResourceTemplates: Record<string, TemplateEntry> }
  )._registeredResourceTemplates;
  const entry = map[name];
  if (entry === undefined) throw new Error(`${name} is not registered`);
  return entry;
}

/**
 * What a resource read settled with — its payload, or the error it refused with.
 *
 * Captured rather than asserted with `rejects`, because the load-bearing half of these
 * cases is WHAT was said and, just as much, what must NOT appear in it.
 */
async function outcome<T>(call: Promise<T>): Promise<T | Error> {
  return await call.catch((error: unknown) => error as Error);
}

let stack: ProbeStack;
let root: string;
const env = createEnvSnapshot(["AKS_STACK_ID", "AKS_DATABASE_URL"]);

beforeEach(async () => {
  root = await scratchProjectRoot("resource-stack-refusal-");
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  stack = await createProbeStack("resource-refusal");
  // Every case starts pointed at the provisioned Stack: the ambient binding S5 removes.
  // Pointing the process at it is what makes "the resource refused" different from "it
  // could not read anything" — the Stack really holds a page, and really answers.
  env.setEnv({ AKS_DATABASE_URL: stack.harness.url, AKS_STACK_ID: stack.harness.stackId });
});

afterEach(async () => {
  env.restore();
  await stack.harness.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** Store one concept page as a row of the provisioned Stack. */
async function seedRowPage(): Promise<void> {
  await createPageWriteSink(stack.harness.db, stack.harness.stackId)({
    directory: "concepts",
    slug: SLUG,
    body: `---\ntitle: Shared\nsummary: s\n---\n\n${ROW_BODY}`,
  });
}

describe("a Stack-scoped resource read with a database configured", () => {
  it("refuses the concept read, and never answers with the Stack the process names", async () => {
    if (!stack.harness.reachable) return;
    await seedRowPage();
    const server = buildServer(root);

    const answer = await outcome(
      templateEntry(server, "wiki-concept").readCallback(new URL(`llmwiki://concept/${SLUG}`), {
        slug: SLUG,
      }),
    );

    expect(answer).toBeInstanceOf(Error);
    const message = (answer as Error).message;
    // The reason is the SHAPE of the surface: this is where a client learns that a
    // resource URI has nowhere to put a Stack.
    expect(message).toContain(SHAPE_CLAUSE);
    // And the way out, which is a tool call and not an environment variable.
    expect(message).toContain(TOOL_CLAUSE);
    // The row the old code served, by name: it must not reach the client.
    expect(message).not.toContain(ROW_BODY);
  });

  it("refuses the compile-state read", async () => {
    if (!stack.harness.reachable) return;
    const server = buildServer(root);

    const answer = await outcome(staticRead(server, "llmwiki://state")(new URL("llmwiki://state")));

    expect(answer).toBeInstanceOf(Error);
    expect((answer as Error).message).toContain(SHAPE_CLAUSE);
  });

  it("refuses the template listing, so the surface says why instead of listing nothing", async () => {
    if (!stack.harness.reachable) return;
    const server = buildServer(root);
    const list = templateEntry(server, "wiki-query").resourceTemplate.listCallback;
    expect(list, "wiki-query must register a list callback").toBeDefined();

    const answer = await outcome((list as NonNullable<typeof list>)());

    expect(answer).toBeInstanceOf(Error);
    expect((answer as Error).message).toContain(SHAPE_CLAUSE);
  });
});

describe("the resources that never consulted a database", () => {
  it("keeps answering a file-only resource on a run with a database configured", async () => {
    if (!stack.harness.reachable) return;
    await writeFile(path.join(root, "wiki/index.md"), "# Checkout Index\n");
    const server = buildServer(root);

    const answer = await staticRead(server, "llmwiki://index")(new URL("llmwiki://index"));

    // `llmwiki://index` reads `wiki/index.md` and never asked a Stack. Refusing it here
    // would be a failure invented where the old code had none.
    expect(answer.contents[0]?.text).toContain("Checkout Index");
  });
});

describe("a Stack-scoped resource with no database configured", () => {
  it("keeps reading this checkout's files, byte for byte", async () => {
    await withFileMode(async () => {
      // No Stack named either: the named `file` authority is what "no database" means.
      delete process.env.AKS_STACK_ID;
      await writePage(path.join(root, "wiki/concepts"), SLUG, { title: "Shared", summary: "s" }, FILE_BODY);
      const server = buildServer(root);

      const read = await templateEntry(server, "wiki-concept").readCallback(
        new URL(`llmwiki://concept/${SLUG}`),
        { slug: SLUG },
      );
      expect(JSON.parse(read.contents[0]?.text ?? "{}")).toMatchObject({ slug: SLUG, body: FILE_BODY });

      const listed = await templateEntry(server, "wiki-concept").resourceTemplate.listCallback?.();
      expect(listed?.resources.map((entry) => entry.uri)).toEqual([`llmwiki://concept/${SLUG}`]);

      const state = await staticRead(server, "llmwiki://state")(new URL("llmwiki://state"));
      expect(JSON.parse(state.contents[0]?.text ?? "{}")).toMatchObject({ version: 1 });
    });
  });
});
