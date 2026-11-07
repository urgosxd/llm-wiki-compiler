/**
 * @file test/mcp/journal-isolation.test.ts
 * @description A tool's journal entry lands in the Stack the CALLER named.
 *
 * ## The condition this pins
 *
 * The journal write (`appendLog` -> `withJournalSource`) resolved its Stack from
 * `process.env`, while every read on the same call resolved it from the `stackId`
 * argument. One process serving several Stacks therefore answered from the named
 * tenant and journalled into the ambient one: a cross-tenant WRITE, which is worse
 * than a wrong read because it survives the call.
 *
 * ## Why both sides are asserted
 *
 * "The entry is in A" alone would pass if the code wrote to BOTH journals. "The entry
 * is not in B" alone would pass if it wrote nowhere at all. Only the pair proves the
 * write was routed. The third assertion — no `log.md` in the shared root — rules out
 * the file backend covering for a lost row.
 *
 * ## Why the tool is driven through MCP
 *
 * The defect lived in the wiring between the registered tool and the journal writer.
 * A helper that builds its own environment would pass while that wiring stayed broken,
 * so every case below calls the tool a caller actually calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { withDerivedSource } from "../../src/dimensions/wiki/derived-artifact-source.js";
import { journalDescriptions, rowOnlyProviderModule, seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/**
 * The page the stubbed selector picks; it only exists as a row.
 *
 * `vi.hoisted` because the `vi.mock` factory below runs while this file's imports are
 * being linked — before a module-body `const` would be initialized — and the factory
 * has to capture the id at that moment.
 */
const SELECTED_PAGE_ID = vi.hoisted(() => "concepts/journal-page");

/** The question text the journal entry must carry. */
const QUESTION = "what does the journal isolate?";

/**
 * Stub the LLM boundary only: page selection and the answer text.
 *
 * Retrieval, the registry seam, the tenant bind, the journal write and the row reads
 * stay production code, because they are what this file measures.
 */
vi.mock("../../src/utils/llm.js", () => rowOnlyProviderModule(SELECTED_PAGE_ID));

describe("tool journal isolation", () => {
  let named: ProbeStack;
  let ambient: ProbeStack;
  let root: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(async () => {
    named = await createProbeStack("journal-named");
    ambient = await createProbeStack("journal-ambient");
    // No wiki/ tree: the page exists only as a row, so disk cannot answer either.
    root = await scratchProjectRoot("journal-isolation-");
    saved = { ...process.env };
    vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  });

  afterEach(async () => {
    process.env = saved;
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await named.harness.cleanup();
    await ambient.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("journals the question to the Stack it names, not the ambient one", async () => {
    await seedRowOnlyPage(named);
    // The process is bound to the OTHER Stack, exactly as a multi-tenant host is.
    process.env.AKS_STACK_ID = ambient.harness.stackId;
    const answered = await askViaTool(buildServer(root), named.harness.stackId);

    expect(answered.answer).toContain("ANSWER_FROM_ROWS");
    // Both sides: NOT in the ambient Stack...
    expect(await journalDescriptions(ambient.harness.stackId)).toEqual([]);
    // ...and written to the named one.
    expect(await journalDescriptions(named.harness.stackId)).toEqual([QUESTION]);
    // The rows path answered, so the shared file must not exist either.
    expect(existsSync(path.join(root, "log.md"))).toBe(false);
  }, 60_000);

  it("keeps journalling in place when the ambient environment names the same Stack", async () => {
    await seedRowOnlyPage(named);
    process.env.AKS_STACK_ID = named.harness.stackId;
    const answered = await askViaTool(buildServer(root), named.harness.stackId);

    expect(answered.answer).toContain("ANSWER_FROM_ROWS");
    // Exactly one entry: the control must not journal twice, once per route.
    expect(await journalDescriptions(named.harness.stackId)).toEqual([QUESTION]);
    expect(await journalDescriptions(ambient.harness.stackId)).toEqual([]);
  }, 60_000);

  it("rebuilds the index from the Stack it names when the answer is saved", async () => {
    await seedRowOnlyPage(named);
    await seedAmbientFilePage(root);
    const answered = await askViaTool(buildServer(root), named.harness.stackId, { save: true });

    // A refusal would leave the index alone and make the assertions below pass for
    // the wrong reason, so the save is required to have really happened.
    expect(answered.saved).toBeTypeOf("string");
    // The index belongs to the Stack the call NAMED, so it is that Stack's row. Read
    // it through the production seam rather than the file: a Stack resolves the
    // artifact destination to its own row, and the file is the NO-Stack fallback.
    const index = await withDerivedSource(
      { AKS_STACK_ID: named.harness.stackId, AKS_DATABASE_URL: named.harness.url } as NodeJS.ProcessEnv,
      async (source) => source!.read("index"),
    );
    // Both sides: the index lists the named Stack's corpus...
    expect(index).toContain("Journal Page");
    // ...and not the deployment's pages, which is exactly what an ambient scan of
    // `wiki/concepts` would have summarised instead.
    expect(index).not.toContain("Ambient Page");
    // The rows path answered, so the file backend must not be covering for it.
    expect(existsSync(path.join(root, "wiki/index.md"))).toBe(false);
  }, 60_000);
});

/** Seed the page the stubbed selector picks, as a row inside `stack`. */
async function seedRowOnlyPage(stack: ProbeStack): Promise<void> {
  await seedConceptPage(
    stack.harness,
    "journal-page",
    `---\ntitle: Journal Page\nsummary: lives in postgres\n---\n\nROW_ONLY_BODY\n`,
  );
}

/**
 * Seed a page that exists ONLY as a file, so an ambient scan is visibly different.
 *
 * The save path rebuilds the index from whichever corpus its environment names. A
 * file page under `wiki/concepts` is what the ambient scan would summarise, so its
 * absence from the result is what proves the named Stack's rows were scanned.
 */
async function seedAmbientFilePage(projectRoot: string): Promise<void> {
  await mkdir(path.join(projectRoot, "wiki/concepts"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "wiki/concepts/ambient-page.md"),
    "---\ntitle: Ambient Page\nsummary: lives on disk\n---\n\nAMBIENT_BODY\n",
  );
}

/** Ask the registered tool one question naming `stackId`, returning the payload. */
async function askViaTool(
  server: ReturnType<typeof buildServer>,
  stackId: string,
  extra: Record<string, unknown> = {},
): Promise<{ answer?: string; saved?: unknown }> {
  const envelope = await callTool(server, "query_wiki", { question: QUESTION, stackId, ...extra });
  return JSON.parse(envelope.content[0]?.text ?? "{}") as { answer?: string; saved?: unknown };
}
