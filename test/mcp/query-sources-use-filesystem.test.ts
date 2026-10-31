/**
 * @file test/mcp/query-sources-use-filesystem.test.ts
 * @description The split this project runs on: PAGES come from Postgres, SOURCE
 * TEXT comes from `sources/` on disk.
 *
 * ## Why both halves are asserted
 *
 * `get_context_pack` reaches two different stores for two different things. Pages
 * are rows, resolved through `withRegistrySource`. The cited source text is NOT in
 * a table: `materializeSourceWindows` reads it out of `sources/<file>`
 * (`context/provenance.ts`).
 *
 * Asserting only one half would let the other regress silently. A pack that lost its
 * pages looks like "nothing was relevant"; a pack that lost its source windows looks
 * like "the citation had no file". Both are wrong answers delivered confidently.
 *
 * ## How each half is proven
 *
 * - Rows: the root has NO `wiki/` tree, so a disk read finds no pages at all.
 * - Files: the cited source is written to `sources/` only, never to a table. A
 *   window carrying the real line proves disk was read; an empty window is what a
 *   row-backed source implementation would produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { useQueryStackFixture } from "../fixtures/query-stack-root.js";
import type { QueryStackFixture } from "../fixtures/query-stack-root.js";
import type { ContextPack } from "../../src/context/build.js";

/** The source file the citation names; it exists ONLY under `sources/`. */
const SOURCE_FILE = "article.md";

/** Line 1 of the source file: the text a window must quote. */
const SOURCE_LINE_ONE = "SOURCE_LINE_ONE_only_on_disk";

/** Body the page row carries; no file holds this text. */
const ROW_BODY = "ROW_BODY_from_postgres about graph traversal";

/**
 * Seed one page carrying an inline citation marker naming the disk file.
 *
 * The marker form (`^[file:1-2]`) is what `extractClaimCitations` parses out of the
 * page body; the viewer collector turns those spans into the page's citations, which
 * the pack then flattens. Written through the sink a compile uses.
 */
async function seedPageWithCitation(fixture: QueryStackFixture): Promise<void> {
  await createPageWriteSink(fixture.stack.harness.db, fixture.stack.harness.stackId)({
    directory: "concepts",
    slug: "cited-page",
    body:
      `---\ntitle: Cited Page\nsummary: cites a disk file\n---\n\n` +
      `${ROW_BODY}^[${SOURCE_FILE}:1-2]\n`,
  });
}

/** Write the cited source file under `sources/` only. */
async function seedSourceFile(root: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(
    path.join(root, "sources", SOURCE_FILE),
    `${SOURCE_LINE_ONE}\nsecond line of the raw source\n`,
    "utf-8",
  );
}

/** Ask the registered tool for a pack that materializes source windows. */
async function requestPack(server: ReturnType<typeof buildServer>): Promise<ContextPack> {
  const envelope = await callTool(server, "get_context_pack", {
    prompt: "graph traversal",
    includeSources: true,
  });
  return JSON.parse(envelope.content[0]?.text ?? "{}") as ContextPack;
}

describe("query sources: rows for pages, filesystem for source text", () => {
  const fixture = useQueryStackFixture("qsf", "query-sources-");

  beforeEach(async () => {
    vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
    await seedPageWithCitation(fixture());
    await seedSourceFile(fixture().root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("materializes a source window by reading sources/ from disk", async () => {
    const { stack, root } = fixture();
    if (!stack.harness.reachable) return;
    const server = buildServer(root);

    const pack = await requestPack(server);
    const windows = pack.primary.flatMap((page) => page.sourceWindows ?? []);

    // The text exists nowhere but `sources/article.md`. A row-backed source store
    // would return no window at all, or a window with an empty `text`.
    expect(windows.length).toBeGreaterThan(0);
    const quoted = windows.map((window) => window.text ?? "").join("\n");
    expect(quoted).toContain(SOURCE_LINE_ONE);
  }, 90_000);

  it("does not invent a window when the cited file is absent from disk", async () => {
    const { stack, root } = fixture();
    if (!stack.harness.reachable) return;
    // The citation now points at nothing on disk. The pack must degrade to no
    // windows rather than fabricate one from the row body.
    await rm(path.join(root, "sources", SOURCE_FILE), { force: true });
    const server = buildServer(root);

    const pack = await requestPack(server);
    const windows = pack.primary.flatMap((page) => page.sourceWindows ?? []);

    expect(windows).toHaveLength(0);
  }, 90_000);
});
