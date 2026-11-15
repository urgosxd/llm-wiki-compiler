/**
 * @file test/sdk/search-embedding-source.test.ts
 * @description The SDK facade's `search` must rank from a Stack's OWN embeddings,
 * and must keep its index fallback on a project that has none.
 *
 * ## The defect these cases pin
 *
 * The MCP `search_pages` tool and this facade both handed `pickSearchRefs` a
 * registry source and nothing else, so retrieval took its on-disk branch on a
 * corpus whose vectors live in `wiki.page_chunk_embeddings`. `query_wiki` passes
 * both sources and does reach them, so the fix is that composition:
 * `withEmbeddingStoreSource` beside `withRegistrySource`.
 *
 * ## Why both backends are covered
 *
 * A Stack-backed corpus is where the vectors were invisible; a file-backed corpus
 * with no `embeddings.json` is where the OLD answer must not change -- same refs,
 * same `embedding-index-outdated` warning, no failure. Asserting only the Stack
 * side would leave that promise untested; asserting only the file side would pass
 * while the defect stands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { seedFallbackProject, stubSelectPages } from "../fixtures/fallback-stub.js";
import {
  bindSearchEnvironment,
  refKinds,
  refSlugs,
  seedEmbeddedCorpus,
  useSearchStackFixture,
  warningCodes,
} from "../fixtures/search-embedding-corpus.js";
import { createWikiCore } from "../../packages/wiki/src/sdk/core.js";
import { callClaude } from "../../packages/wiki/src/utils/llm.js";

vi.mock("../../packages/wiki/src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const fixture = useSearchStackFixture("sdk-search-emb", "sdk-search-emb-");

describe("SDK search over a Stack-backed corpus", () => {
  it("ranks from the Stack's embeddings instead of falling back to the index", async () => {
    const { harness, root, env } = fixture();
    await seedEmbeddedCorpus(harness);
    // The stub the fallback would use, so a fallback cannot hide behind "no refs".
    await stubSelectPages(["concepts/alpha"]);

    const outcome = await createWikiCore({ root, env: env() }).search("what is alpha");

    expect(refSlugs(outcome)).toEqual(["alpha", "beta"]);
    expect(refKinds(outcome)).not.toContain("index");
    expect(warningCodes(outcome)).not.toContain("embedding-index-outdated");
    expect(vi.mocked(callClaude)).not.toHaveBeenCalled();
  });
});

describe("SDK search over a file-backed corpus with no embeddings", () => {
  let root: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await seedFallbackProject("sdk-search-files", {
      concept: "alpha",
      query: "q-one",
      typed: "p-one",
    });
    savedEnv = bindSearchEnvironment();
  });

  afterEach(async () => {
    process.env = savedEnv;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the index fallback and its warning exactly as before", async () => {
    // No Stack and no `embeddings.json`: the behaviour this change must not touch.
    await stubSelectPages(["concepts/alpha"]);

    const outcome = await createWikiCore({
      root,
      env: { ...process.env, AKS_STACK_ID: "" },
    }).search("what is alpha");

    expect(refKinds(outcome)).toEqual(["index"]);
    expect(refSlugs(outcome)).toEqual(["alpha"]);
    expect(warningCodes(outcome)).toEqual(["embedding-index-outdated"]);
    expect(JSON.stringify(outcome)).toContain("No embedding index found.");
  });
});
