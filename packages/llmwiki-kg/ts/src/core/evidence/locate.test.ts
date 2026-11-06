/**
 * @file packages/llmwiki-kg/ts/src/core/evidence/locate.test.ts
 * @description Locating an extractor's quote inside the chunk it came from.
 *
 * WHY THIS FILE EXISTS. The quote is the only thing tying a candidate claim to
 * the source, so "this quote exists" has to be a measured fact: either a span
 * into the ORIGINAL chunk text, or an honest `not_found`. Every test here checks
 * one half of that contract — exact spans, the bounded normalization folds, and
 * the cases that must never become a match (an absent quote, a quote that spans
 * a chunk boundary, and a morphological near miss).
 */

import { describe, expect, it } from "vitest";

import { locateQuote, locateQuoteInChunks } from "./locate.js";
import type { QuoteLocation, QuoteSpan } from "./types.js";

/** The sample chunk every exact-match test measures against. */
const CHUNK = "The reviewer signs the policy. The policy governs the change process.";

/** The quote that is present verbatim in {@link CHUNK}. */
const QUOTE = "The policy governs the change process.";

/** Unwraps a location that must have been found, failing loudly otherwise. */
function foundSpan(location: QuoteLocation): QuoteSpan {
  if (location.status !== "found") {
    throw new Error("expected a located quote, got not_found");
  }
  return location.span;
}

describe("locateQuote", () => {
  it("returns exact offsets into the original chunk text", () => {
    const span = foundSpan(locateQuote(QUOTE, CHUNK));
    expect(span.match).toBe("exact");
    expect(span.charStart).toBe(CHUNK.indexOf(QUOTE));
    expect(span.charEnd).toBe(CHUNK.length);
    expect(CHUNK.slice(span.charStart, span.charEnd)).toBe(QUOTE);
  });

  it("locates a quote that only exists after controlled normalization", () => {
    const chunk = "El comité “deja sin efecto” la política — sin excepción.";
    const quote = '"deja sin efecto" la política - sin excepción.';
    const span = foundSpan(locateQuote(quote, chunk));
    expect(span.match).toBe("normalized");
    expect(chunk.slice(span.charStart, span.charEnd)).toBe(
      "“deja sin efecto” la política — sin excepción.",
    );
  });

  it("folds case and whitespace runs but reports original offsets", () => {
    const chunk = "El sistema\n   soporta el proceso.";
    const span = foundSpan(locateQuote("el sistema soporta el proceso.", chunk));
    expect(span.match).toBe("normalized");
    expect(span.charStart).toBe(0);
    expect(span.charEnd).toBe(chunk.length);
    expect(chunk.slice(span.charStart, span.charEnd)).toBe(chunk);
  });

  it("returns not_found for an absent quote instead of a substitute span", () => {
    expect(locateQuote("El rol aprueba el documento.", "El rol firma el documento.")).toEqual({
      status: "not_found",
    });
    expect(locateQuote("", CHUNK)).toEqual({ status: "not_found" });
    expect(locateQuote("   ", CHUNK)).toEqual({ status: "not_found" });
    expect(locateQuote(QUOTE, "")).toEqual({ status: "not_found" });
  });

  it("does not stem, join synonyms or tolerate edit distance", () => {
    expect(locateQuote("roles execute processes", "A role executes a process.")).toEqual({
      status: "not_found",
    });
    expect(locateQuote("The policy governs the change proces.", CHUNK)).toEqual({
      status: "not_found",
    });
    expect(locateQuote("The policy governs the process.", CHUNK)).toEqual({ status: "not_found" });
  });
});

describe("locateQuoteInChunks", () => {
  /** Two chunks whose text, concatenated, would contain the spanning quote below. */
  const CHUNKS = [
    { chunkId: "chunk-0", chunkIndex: 0, content: "The policy governs" },
    { chunkId: "chunk-1", chunkIndex: 1, content: "the change process. A reviewer signs it." },
  ];

  it("returns not_found for a quote that spans a chunk boundary", () => {
    expect(
      locateQuoteInChunks("The policy governs the change process.", CHUNKS),
    ).toEqual({ status: "not_found" });
  });

  it("reports offsets inside the matched chunk only, never a joined text", () => {
    const quote = "A reviewer signs it.";
    const match = locateQuoteInChunks(quote, CHUNKS);
    if (match.status !== "found") {
      throw new Error("expected a located quote");
    }
    expect(match.chunk.chunkId).toBe("chunk-1");
    expect(match.chunk.chunkIndex).toBe(1);
    expect(match.span.charStart).toBe(20);
    expect(match.chunk.content.slice(match.span.charStart, match.span.charEnd)).toBe(quote);
  });
});
