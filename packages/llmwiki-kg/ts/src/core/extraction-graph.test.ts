/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-graph.test.ts
 * @description Triplet parsing, graph extraction and the extraction prompt.
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

import { extractGraphFromChunks, parseTriplets } from "./extraction.js";
import { chunk, lastToolPrompt, restoreToolCall, setToolFailure, setToolResponse, stubToolCall, toolCalls } from "./extraction-harness.js";

describe("parseTriplets", () => {
  /** A complete, well-formed tool-call payload. */
  const VALID = JSON.stringify({
    triplets: [
      {
        subject: { type: "PRODUCT", name: "Gateway" },
        relation: { type: "USED_FOR" },
        object: { type: "CONCEPT", name: "Routing" },
      },
    ],
  });

  it("parses a well-formed payload", () => {
    expect(parseTriplets(VALID)).toEqual([
      {
        subjectName: "Gateway",
        subjectType: "PRODUCT",
        relationType: "USED_FOR",
        objectName: "Routing",
        objectType: "CONCEPT",
      },
    ]);
  });

  it("normalises relation and entity types the way llama_index does", () => {
    // `validate` runs `type.replace(" ", "_").upper()` on every endpoint.
    const payload = JSON.stringify({
      triplets: [
        {
          subject: { type: "knowledge area", name: "Search" },
          relation: { type: "used for" },
          object: { type: "sub system", name: "Index" },
        },
      ],
    });
    const [triplet] = parseTriplets(payload);
    expect(triplet?.subjectType).toBe("KNOWLEDGE_AREA");
    expect(triplet?.relationType).toBe("USED_FOR");
    expect(triplet?.objectType).toBe("SUB_SYSTEM");
  });

  it("drops self-references", () => {
    // `_prune_invalid_triplets` removes `subject.lower() == object.lower()`,
    // including case differences.
    const payload = JSON.stringify({
      triplets: [
        {
          subject: { type: "CONCEPT", name: "Ontology" },
          relation: { type: "PART_OF" },
          object: { type: "CONCEPT", name: "ontology" },
        },
      ],
    });
    expect(parseTriplets(payload)).toEqual([]);
  });

  it("drops malformed triplets but keeps valid siblings", () => {
    // A triplet missing `name` fails Pydantic validation and is skipped — it
    // does not abort the whole extraction.
    const payload = JSON.stringify({
      triplets: [
        {
          subject: { type: "PRODUCT", name: "Gateway" },
          relation: { type: "HAS" },
          object: { type: "CONCEPT" },
        },
        {
          subject: { type: "PRODUCT", name: "Gateway" },
          relation: { type: "USED_FOR" },
          object: { type: "CONCEPT", name: "Routing" },
        },
      ],
    });
    const triplets = parseTriplets(payload);
    expect(triplets).toHaveLength(1);
    expect(triplets[0]?.objectName).toBe("Routing");
  });

  it("accepts a payload wrapped in prose", () => {
    // Chatty models sometimes prefix the JSON with a sentence. The Python path
    // never sees this (the SDK hands over a parsed tool call), so tolerating it
    // is a deliberate robustness addition, not part of the oracle contract.
    const wrapped = `Here is the graph:\n${VALID}\nDone.`;
    expect(parseTriplets(wrapped)).toHaveLength(1);
  });

  it("accepts a JSON string containing the payload", () => {
    const doublyEncoded = JSON.stringify(VALID);
    expect(parseTriplets(doublyEncoded)).toHaveLength(1);
  });

  it("returns no triplets for unparseable input rather than throwing", () => {
    // Mirrors `_aextract`'s `except (ValueError, TypeError, AttributeError)`:
    // one bad chunk must not fail the document.
    expect(parseTriplets("not json at all")).toEqual([]);
    expect(parseTriplets("")).toEqual([]);
    expect(parseTriplets("{}")).toEqual([]);
    expect(parseTriplets('{"triplets": "nope"}')).toEqual([]);
  });

  it("trims whitespace around entity names", () => {
    const payload = JSON.stringify({
      triplets: [
        {
          subject: { type: "PRODUCT", name: "  Gateway  " },
          relation: { type: "HAS" },
          object: { type: "CONCEPT", name: " Routing " },
        },
      ],
    });
    const [triplet] = parseTriplets(payload);
    expect(triplet?.subjectName).toBe("Gateway");
    expect(triplet?.objectName).toBe("Routing");
  });
});

describe("extractGraphFromChunks", () => {
  beforeEach(() => {
    stubToolCall();
  });

  afterEach(() => {
    restoreToolCall();
  });

  it("returns an empty result for no chunks without calling the model", async () => {
    const result = await extractGraphFromChunks([], "w2ex-stack");
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.pipeline).toBe("llamaindex-schema-extraction");
    expect(toolCalls()).toBe(0);
  });

  it("makes exactly one model call per chunk", async () => {
    const chunks = [chunk(0, "first"), chunk(1, "second"), chunk(2, "third")];
    await extractGraphFromChunks(chunks, "w2ex-stack");
    // Cost contract: one call per chunk, nothing more.
    expect(toolCalls()).toBe(3);
  });

  it("deduplicates entities by lowercased name and merges chunk indices", async () => {
    setToolResponse([
      {
        triplets: [
          {
            subject: { type: "PRODUCT", name: "Gateway" },
            relation: { type: "HAS" },
            object: { type: "CONCEPT", name: "Routing" },
          },
        ],
      },
      {
        triplets: [
          {
            subject: { type: "PRODUCT", name: "gateway" },
            relation: { type: "PART_OF" },
            object: { type: "CONCEPT", name: "Platform" },
          },
        ],
      },
    ]);

    const result = await extractGraphFromChunks(
      [chunk(0, "first"), chunk(1, "second")],
      "w2ex-stack",
    );

    const names = result.entities.map((entity) => entity.name).sort();
    expect(names).toEqual(["Gateway", "Platform", "Routing"]);

    const gateway = result.entities.find((entity) => entity.name === "Gateway");
    // The first spelling wins because extraction confidence is uniform, so the
    // replacement branch never fires.
    expect(gateway?.sourceChunkIndices).toEqual([0, 1]);
    // Every extracted entity carries the same literal confidence.
    expect(gateway?.confidence).toBe(0.7);
    // Descriptions are empty unless synthesis runs.
    expect(gateway?.description).toBe("");
  });

  it("deduplicates relationships on (from, type, to), lowercased", async () => {
    setToolResponse([
      {
        triplets: [
          {
            subject: { type: "PRODUCT", name: "Gateway" },
            relation: { type: "USED_FOR" },
            object: { type: "CONCEPT", name: "Routing" },
          },
        ],
      },
      {
        triplets: [
          {
            subject: { type: "PRODUCT", name: "gateway" },
            relation: { type: "used_for" },
            object: { type: "CONCEPT", name: "routing" },
          },
        ],
      },
    ]);

    const result = await extractGraphFromChunks(
      [chunk(0, "first"), chunk(1, "second")],
      "w2ex-stack",
    );

    expect(result.relationships).toHaveLength(1);
    const relationship = result.relationships[0];
    expect(relationship?.type).toBe("USED_FOR");
    expect(relationship?.confidence).toBe(0.7);
    expect(relationship?.sourceChunkIndices).toEqual([0, 1]);
  });

  it("survives a model response with no tool call", async () => {
    // The provider answering without a tool call must degrade to "no triplets",
    // not to a failed document.
    setToolFailure();
    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack");
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
  });
});

describe("extraction prompt", () => {
  it("renders the node content exactly as llama_index does", async () => {
    // Captured from the live LlamaIndex call: metadata lines, a blank line, then
    // the chunk body. The metadata is visible to the model, so its exact form is
    // part of the prompt.
    setToolResponse([{ triplets: [] }]);
    try {
      await extractGraphFromChunks([chunk(7, "AKS servers run on Kubernetes.")], "demo");
      const prompt = lastToolPrompt();
      expect(prompt).toContain("chunk_index: 7\nstack_name: demo\n\nAKS servers run on Kubernetes.");
    } finally {
      restoreToolCall();
    }
  });

  it("keeps the oracle's prompt text, typo included", async () => {
    setToolResponse([{ triplets: [] }]);
    try {
      await extractGraphFromChunks([chunk(0, "text")], "demo");
      const prompt = lastToolPrompt();
      // "20 extracted paths.s" — the stray "s" is in the Python prompt. Changing
      // it would change the model's input, so it is preserved on purpose.
      expect(prompt).toContain("Try to limit to the output 20 extracted paths.s");
      expect(prompt.startsWith("Give the following text, extract the knowledge graph")).toBe(true);
    } finally {
      restoreToolCall();
    }
  });
});
