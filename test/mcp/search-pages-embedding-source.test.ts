/**
 * @file test/mcp/search-pages-embedding-source.test.ts
 * @description `search_pages` must rank from the Stack's OWN embeddings, not from
 * the on-disk store a Stack-backed corpus does not have.
 *
 * ## The defect these cases pin
 *
 * Measured on a real Stack that HAD 21 page embeddings + 114 chunk embeddings,
 * `search_pages` returned three refs, every one `kind: "index"`, plus
 * `{code: "embedding-index-outdated", message: "No embedding index found."}`.
 * The tool handed `pickSearchRefs` a registry source but no embedding store
 * source, so retrieval took the on-disk branch and found no `embeddings.json`
 * while the vectors sat in `wiki.page_chunk_embeddings` the whole time.
 * `query_wiki` passes BOTH sources on the same corpus and does reach them.
 *
 * ## Why `callClaude` is asserted silent
 *
 * The index fallback IS an LLM selection. Asserting the selector was never called
 * separates "ranked from embeddings" from "fell back and happened to return the
 * refs the stub was told to return".
 *
 * ## Why the no-embeddings case lives here too
 *
 * A corpus with no embedding store must behave exactly as today: index refs plus
 * the same warning. That is the second case, over the same rows with no store
 * written.
 */

import { describe, expect, it, vi } from "vitest";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { stubSelectPages } from "../fixtures/fallback-stub.js";
import {
  refKinds,
  refSlugs,
  seedEmbeddedCorpus,
  seedPages,
  useSearchStackFixture,
  warningCodes,
} from "../fixtures/search-embedding-corpus.js";
import { callClaude } from "../../packages/wiki/src/utils/llm.js";

vi.mock("../../packages/wiki/src/utils/llm.js", () => ({ callClaude: vi.fn() }));

/**
 * Drive the registered `search_pages` handler and return its JSON payload.
 *
 * @param root - Project root the tool was registered against.
 * @param stackId - Stack the call names.
 * @param question - Query to rank pages for.
 * @returns The tool's `{ pages, refs, warnings }` payload.
 */
async function searchStack(root: string, stackId: string, question: string): Promise<unknown> {
  const outcome = await callTool(buildServer(root), "search_pages", { question, stackId });
  if (outcome.isError === true) {
    throw new Error(`search_pages failed: ${JSON.stringify(outcome.content)}`);
  }
  return outcome.structuredContent?.result;
}

const fixture = useSearchStackFixture("search-pages-emb", "search-pages-emb-");

describe("search_pages on a Stack-backed corpus", () => {
  it("ranks from the Stack's embeddings instead of falling back to the index", async () => {
    const { harness, root, embed } = fixture();
    await seedEmbeddedCorpus(harness);
    // The stub the fallback would use, so a fallback cannot hide behind "no refs".
    await stubSelectPages(["concepts/alpha"]);

    const payload = await searchStack(root, harness.stackId, "what is alpha");

    expect(refSlugs(payload)).toEqual(["alpha", "beta"]);
    expect(refKinds(payload)).not.toContain("index");
    expect(warningCodes(payload)).not.toContain("embedding-index-outdated");
    expect(vi.mocked(callClaude)).not.toHaveBeenCalled();
    // The cost this change introduces, pinned where it is visible: ranking from
    // embeddings embeds the QUESTION, one provider request per call, where the
    // on-disk branch this call used to take made none on a Stack-backed corpus.
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("keeps the index fallback and its warning when the Stack has no embeddings", async () => {
    const { harness, root } = fixture();
    await seedPages(harness);
    await stubSelectPages(["concepts/alpha"]);

    const payload = await searchStack(root, harness.stackId, "what is alpha");

    expect(refKinds(payload)).toEqual(["index"]);
    expect(refSlugs(payload)).toEqual(["alpha"]);
    expect(warningCodes(payload)).toContain("embedding-index-outdated");
    expect(JSON.stringify(payload)).toContain("No embedding index found.");
  });
});
