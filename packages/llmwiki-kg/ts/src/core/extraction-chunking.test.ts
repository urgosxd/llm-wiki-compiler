/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-chunking.test.ts
 * @description `chunkAndEmbed`: split, count and embed one document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Provider configuration, hoisted above the `./extraction.js` import.
 *
 * `config` parses `process.env` once at module load, so the environment must be
 * in place before that module is imported. Vitest hoists `vi.hoisted` above
 * imports, which is what makes this possible without a setup file. It has to
 * live in each test file: a helper module is imported too late.
 */
vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
});

import { chunkAndEmbed } from "./extraction.js";
import { DOCUMENT_ID, EMBEDDING_DIM, STACK_ID, embeddingCalls, restoreEmbeddings, stubEmbeddings } from "./extraction-harness.js";

describe("chunkAndEmbed", () => {
  beforeEach(() => {
    // The embedding call is faked: `embedTexts` is exercised against a real
    // gateway only in the route suite. Here the point is ordering, hashing and
    // index assignment.
    stubEmbeddings();
  });

  afterEach(() => {
    restoreEmbeddings();
  });

  it("returns no chunks for an empty document, without calling the provider", async () => {
    const chunks = await chunkAndEmbed("   \n\n  ", STACK_ID, DOCUMENT_ID);
    expect(chunks).toEqual([]);
    expect(embeddingCalls()).toBe(0);
  });

  it("assigns sequential indices, hashes and vectors one batch call", async () => {
    const text = "One sentence here. Another sentence follows. A third one ends it.";
    const chunks = await chunkAndEmbed(text, STACK_ID, DOCUMENT_ID);

    expect(chunks).toHaveLength(1);
    expect(embeddingCalls()).toBe(1);

    const chunk = chunks[0];
    expect(chunk).toBeDefined();
    if (chunk === undefined) {
      return;
    }
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.content).toBe(text);
    expect(chunk.stackId).toBe(STACK_ID);
    expect(chunk.documentId).toBe(DOCUMENT_ID);
    expect(chunk.chunkerStrategy).toBe("sentence");
    // sha256 of the chunk text, matching `hashlib.sha256(...).hexdigest()`.
    expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chunk.embedding).toHaveLength(EMBEDDING_DIM);
    expect(chunk.tokenCount).toBeGreaterThan(0);
  });

  it("issues exactly one embedding request for a multi-chunk document", async () => {
    // Cost guard, asserted rather than assumed: a long document must not become
    // one HTTP call per chunk.
    const text = Array.from({ length: 400 }, (_, index) => `Sentence number ${String(index)} is here.`).join(" ");
    const chunks = await chunkAndEmbed(text, STACK_ID, DOCUMENT_ID);

    expect(chunks.length).toBeGreaterThan(1);
    expect(embeddingCalls()).toBe(1);
    // Indices are contiguous from zero, which is what the unique
    // (document_id, chunk_index) constraint relies on for the upsert.
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it("reconstructs chunk text from the source", async () => {
    const text = "Alpha sentence. Beta sentence. Gamma sentence.";
    const chunks = await chunkAndEmbed(text, STACK_ID, DOCUMENT_ID);
    expect(text).toContain(chunks[0]?.content ?? "<missing>");
  });
});
