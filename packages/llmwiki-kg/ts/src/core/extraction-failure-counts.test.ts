/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-failure-counts.test.ts
 * @description Shape-mangled responses: the third outcome a chunk can produce.
 *
 * WHY THIS FILE EXISTS. `chunkTriplets` used to report two outcomes per chunk:
 * it answered, or the provider failed. A response that arrived intact but whose
 * JSON is unusable — truncated, `{"triplets": "nope"}`, `{}` — fell into the
 * first bucket and looked exactly like a chunk with nothing to extract, so "0
 * triplets" stayed ambiguous for the operator.
 *
 * The cases below pin the third outcome and, just as importantly, the two it
 * must never be confused with: a provider failure (`failedChunks`) and a
 * legitimately empty answer (neither counter present).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Provider configuration, hoisted above the `./extraction.js` import.
 *
 * `config` reads `process.env` once at module load, so the environment must be
 * in place before that module is imported. This block has to live in each test
 * file: a helper module is imported too late to hoist.
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

import { extractGraphFromChunks } from "./extraction.js";
import {
  chatResponses,
  chunk,
  restoreToolCall,
  setToolFailure,
  setToolResponse,
  stubToolCall,
  toolCalls,
} from "./extraction-harness.js";
import { isShapeMangled } from "./graph-parse.js";

/** A response the provider returned successfully, with an unusable envelope. */
const MANGLED = { triplets: "nope" };

/** A legitimate "nothing here" answer that still carries a standalone entity. */
const EMPTY_WITH_ENTITY = {
  triplets: [],
  entities: [{ type: "REQUIREMENT", name: "Retention" }],
};

/** One well-formed triplet, the healthy path's payload. */
const HEALTHY = {
  triplets: [
    {
      subject: { type: "PRODUCT", name: "Gateway" },
      relation: { type: "USED_FOR" },
      object: { type: "CONCEPT", name: "Routing" },
    },
  ],
};

describe("shape-mangled chunks", () => {
  beforeEach(() => {
    stubToolCall();
  });

  afterEach(() => {
    restoreToolCall();
  });

  it("counts a mangled response without calling it a provider failure", async () => {
    setToolResponse([MANGLED]);
    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack");
    expect(result.mangledChunks).toBe(1);
    // The two counters answer different questions and must never be conflated.
    expect(result.failedChunks).toBeUndefined();
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(toolCalls()).toBe(1);
  });

  it("keeps a legitimately empty answer at zero", async () => {
    setToolResponse([{ triplets: [], entities: [] }]);
    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack");
    // Absent, not zero: a healthy run keeps the oracle's exact result shape.
    expect("mangledChunks" in result).toBe(false);
    expect(result.failedChunks).toBeUndefined();
    expect(result.entities).toEqual([]);
  });

  it("does not call an entities-only answer mangled", async () => {
    // The `entities` half of the definition. A chunk that answers with real nodes
    // and no `triplets` key at all arrived intact, so counting it as degraded
    // would report a mangled chunk for every document whose model reported only
    // entities -- the opposite of the counter's purpose.
    setToolResponse([{ entities: [{ type: "REQUIREMENT", name: "Retention" }] }]);

    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack");

    expect("mangledChunks" in result).toBe(false);
    expect(result.entities.map((entity) => entity.name)).toEqual(["Retention"]);
    expect(result.relationships).toEqual([]);
  });

  it("counts only the mangled chunk of a mixed run", async () => {
    setToolResponse([MANGLED, EMPTY_WITH_ENTITY]);
    const result = await extractGraphFromChunks(
      [chunk(0, "first"), chunk(1, "second")],
      "w2ex-stack",
    );
    expect(result.mangledChunks).toBe(1);
    // The healthy chunk still contributes everything it found.
    expect(result.entities.map((entity) => entity.name)).toEqual(["Retention"]);
    expect(result.relationships).toEqual([]);
    expect(result.failedChunks).toBeUndefined();
    expect(toolCalls()).toBe(2);
  });

  it("does not throw when every chunk is mangled", async () => {
    setToolResponse([MANGLED, MANGLED]);
    const result = await extractGraphFromChunks(
      [chunk(0, "first"), chunk(1, "second")],
      "w2ex-stack",
    );
    // Not fatal: a mangled shape is a degraded answer, not an outage.
    expect(result.mangledChunks).toBe(2);
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
  });
});

describe("isShapeMangled", () => {
  it("flags a non-blank response with no usable envelope", () => {
    expect(isShapeMangled("not json at all")).toBe(true);
    expect(isShapeMangled('{"triplets": "nope"}')).toBe(true);
    expect(isShapeMangled("{}")).toBe(true);
    expect(isShapeMangled('{"foo":1}')).toBe(true);
    expect(isShapeMangled("[]")).toBe(true);
  });

  it("treats a blank response as empty rather than mangled", () => {
    expect(isShapeMangled("")).toBe(false);
    expect(isShapeMangled("   \n\t")).toBe(false);
  });

  it("treats a present envelope as a legitimate answer", () => {
    expect(isShapeMangled('{"triplets": [], "entities": []}')).toBe(false);
    expect(isShapeMangled('{"entities":[{"type":"TEAM","name":"Platform"}]}')).toBe(false);
    // Individually malformed entries stay the triplet parser's business: the
    // envelope is readable, so this chunk is not mangled.
    expect(
      isShapeMangled('{"triplets":[{"subject":{"type":"PRODUCT"},"relation":{}}],"entities":[]}'),
    ).toBe(false);
  });
});

describe("the outcomes a mangled count must not disturb", () => {
  beforeEach(() => {
    stubToolCall();
  });

  afterEach(() => {
    restoreToolCall();
  });

  it("leaves a healthy run's result shape untouched", async () => {
    setToolResponse([HEALTHY]);
    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack");
    expect(result.entities.map((entity) => entity.name).sort()).toEqual(["Gateway", "Routing"]);
    expect(result.relationships).toHaveLength(1);
    expect(result.mangledChunks).toBeUndefined();
    expect(result.failedChunks).toBeUndefined();
    expect(result.pipeline).toBe("llamaindex-schema-extraction");
  });

  it("still fails the document when EVERY chunk failed extraction", async () => {
    setToolFailure();
    await expect(extractGraphFromChunks([chunk(0, "first")], "w2ex-stack")).rejects.toThrow(
      /provider unavailable/i,
    );
  });

  it("never counts a provider failure as shape-mangled", async () => {
    // A partial outage, which the harness can only express with raw responders:
    // three attempts that answer without a tool call (transient, so all three
    // are spent) and then one usable answer for the second chunk.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      chatResponses.push(() => ({ choices: [] }));
    }
    setToolResponse([HEALTHY]);
    const result = await extractGraphFromChunks(
      [chunk(0, "first"), chunk(1, "second")],
      "w2ex-stack",
    );
    expect(result.failedChunks).toBe(1);
    expect(result.mangledChunks).toBeUndefined();
    expect(result.relationships).toHaveLength(1);
  });
});
