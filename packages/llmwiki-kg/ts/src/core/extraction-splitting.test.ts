/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-splitting.test.ts
 * @description The SentenceSplitter port and token counting.
 */

import { describe, expect, it, vi } from "vitest";

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

import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, countTokens, splitText } from "./extraction.js";
import { SPLITTER_FIXTURES, TECHNICAL_PROSE, characterCounter } from "./extraction-harness.js";

describe("splitText (SentenceSplitter port)", () => {
  /**
   * The one test that matters most in this file: exact chunk output against the
   * real LlamaIndex splitter, on every generated case.
   *
   * A failure here means the port's algorithm diverged from LlamaIndex's, which
   * would put different text in `document_chunks` than the oracle stores.
   */
  it.each(SPLITTER_FIXTURES)(
    "reproduces llama_index chunk output: $name",
    (fixture) => {
      const chunks = splitText(
        fixture.text,
        fixture.chunkSize,
        fixture.chunkOverlap,
        characterCounter,
      );
      expect(chunks).toEqual(fixture.chunks);
    },
  );

  it("drops a whitespace-only document entirely", () => {
    // llama_index's `_postprocess_chunks` skips stripped-empty chunks, so a
    // whitespace-only input yields no nodes at all — which is what makes
    // ingesting such a file free (no embedding call).
    expect(splitText("   ", 1024, 200, characterCounter)).toEqual([]);
    expect(splitText("\n\n\n", 1024, 200, characterCounter)).toEqual([]);
  });

  it("returns the empty string unchanged for empty input", () => {
    // `_split_text("")` returns `[""]` before any of the merge logic runs. The
    // caller filters it; the function itself preserves the Python behaviour.
    expect(splitText("", 1024, 200, characterCounter)).toEqual([""]);
  });

  it("keeps a document under the budget as a single trimmed chunk", () => {
    const chunks = splitText("  One sentence only.  ", 1024, 200, characterCounter);
    expect(chunks).toEqual(["One sentence only."]);
  });

  it("defaults to the production chunk size and overlap", () => {
    // Guards the two constants the whole slice depends on. 1024/200 is what
    // `_DEFAULT_CHUNK_SIZE` / `_DEFAULT_CHUNK_OVERLAP` are in Python, and a
    // silent change here would change every stored chunk.
    expect(DEFAULT_CHUNK_SIZE).toBe(1024);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(200);

    // A single sentence below 1024 tokens stays whole under the defaults.
    const sentence = "The gateway routes embedding traffic for the extraction pipeline.";
    expect(splitText(sentence)).toEqual([sentence]);
  });

  it("carries overlap from the end of the previous chunk", () => {
    // With overlap 8 and one-token-per-character, a closed chunk contributes its
    // tail to the next one, so consecutive chunks repeat text. This is the
    // property that makes retrieval recall work across a boundary.
    const text = "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.";
    const chunks = splitText(text, 24, 8, characterCounter);
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0] ?? "";
    const second = chunks[1] ?? "";
    const tail = first.slice(-4);
    expect(second).toContain(tail);
  });

  it("throws when a single unit cannot be broken down to the budget", () => {
    // llama_index raises `ValueError("Single token exceeded chunk size")` when a
    // split is still oversized after recursing to characters. Reproduced because
    // a silently oversized chunk would corrupt the token accounting.
    const counter = (): number => 5_000;
    expect(() => splitText("anything", 10, 2, counter)).toThrow(
      "Single token exceeded chunk size",
    );
  });
});

describe("countTokens", () => {
  /**
   * Reference counts, measured with the real `tiktoken` `cl100k_base` encoder.
   *
   * The tolerance is stated per case and is deliberately tight for text whose
   * exact count the approximation reproduces, and looser where the counts were
   * measured to drift. Asserting an exact number everywhere would be dishonest:
   * this is an approximation, and the point of these tests is to pin its
   * accuracy, not to pretend it is exact.
   */
  it.each([
    ["empty", "", 0],
    ["single word", "hello", 1],
    ["short sentence", "The gateway routes traffic.", 5],
    ["digits group in threes", "1234567890", 4],
    ["whitespace run", "a\n\nb", 3],
  ])("counts %s", (_label, text, expected) => {
    expect(countTokens(text)).toBe(expected);
  });

  it("lands within one token of exact on the oracle's own stored chunk", () => {
    // Measured: this exact chunk was written by a real ingest against the live
    // oracle, where `token_count = 37`; the real encoder independently confirms
    // 37. The estimator answers 36 — one token under, which is the honest
    // accuracy of the approximation and the reason the chunker is verified
    // separately with an exact counter.
    const chunk =
      "The AKS reference server compiles documents into an ontology. " +
      "A Stack owns that ontology.\n\nThe gateway routes embedding traffic " +
      "for the extraction pipeline. Nomic Embed produces vectors for every chunk.";
    expect(Math.abs(countTokens(chunk) - 37)).toBeLessThanOrEqual(1);
  });

  it("stays within 3% of exact cl100k on technical prose", () => {
    // Measured with the real `cl100k_base` encoder: 614 tokens for this passage.
    // 3% is the documented accuracy bound — see the module comment in
    // extraction.ts for how the estimator is calibrated.
    const prose = TECHNICAL_PROSE;
    const exact = 614;
    const estimate = countTokens(prose);
    expect(Math.abs(estimate - exact) / exact).toBeLessThan(0.03);
  });

  it("is monotonic and non-negative", () => {
    const samples = ["", "a", "a b", "a b c", "a b c d e f g h i j"];
    let previous = -1;
    for (const sample of samples) {
      const count = countTokens(sample);
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });
});
