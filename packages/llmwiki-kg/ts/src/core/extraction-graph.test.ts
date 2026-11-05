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
import { validateOntology } from "./ontology.js";

/** A declaration whose entity types exclude the model's default `PRODUCT`. */
const ONTOLOGY = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["SUPPLIES"],
  subtypes: [],
});

/** One payload carrying a single out-of-ontology entity type. */
const OFF_SCHEMA = {
  triplets: [
    {
      subject: { type: "PRODUCT", name: "Gateway" },
      relation: { type: "SUPPLIES" },
      object: { type: "PERSON", name: "Ada" },
    },
  ],
};

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

  it("keeps one entity when a triplet and a standalone entry name the same node", async () => {
    // `absorbEndpoint` rewrites a type only on a strict confidence increase, which
    // never happens here (every extraction carries the same confidence), so the
    // FIRST type seen wins. Triplet endpoints are folded before standalone
    // entities, so the type a relationship already constrains is the survivor --
    // silently, which is exactly why it needs a pin.
    setToolResponse([
      {
        triplets: [
          {
            subject: { type: "COMPANY", name: "Acme" },
            relation: { type: "SUPPLIES" },
            object: { type: "PERSON", name: "Ada" },
          },
        ],
        entities: [{ type: "ORGANIZATION", name: "acme" }],
      },
    ]);

    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack");

    // Acme and Ada, and no third row for the standalone spelling of Acme.
    expect(result.entities).toHaveLength(2);
    const acme = result.entities.filter((entity) => entity.name.toLowerCase() === "acme");
    expect(acme).toHaveLength(1);
    expect(acme[0]?.name).toBe("Acme");
    expect(acme[0]?.type).toBe("COMPANY");
    // Cumulative, not deduplicated: the endpoint and the standalone entry each
    // recorded chunk 0.
    expect(acme[0]?.sourceChunkIndices).toEqual([0, 0]);
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

  it("fails the document when EVERY chunk failed extraction", async () => {
    // The contract this pins: a provider that fails every chunk is an OUTAGE,
    // not an empty corpus. Before this, the call returned an empty result and
    // the dimension committed a document with an empty graph -- indistinguishable
    // from "the document contained nothing".
    setToolFailure();
    await expect(extractGraphFromChunks([chunk(0, "first")], "w2ex-stack")).rejects.toThrow(
      /provider unavailable|503|500/,
    );
  });

  it("retries a failing chunk before giving up on it", async () => {
    // One provider failure must not be enough to lose the chunk: the retry
    // policy inside `withProviderRetry` gets three attempts.
    setToolFailure();
    await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack").catch(() => undefined);
    // One chunk, three attempts -- not one call and no retry.
    expect(toolCalls()).toBe(3);
  });

  it("keeps the document when SOME chunks succeeded, and reports the failures", async () => {
    // Oracle-parity tolerance: one bad chunk must not discard a whole document.
    // The degradation is surfaced in `failedChunks` instead of staying silent.
    const chunks = [chunk(0, "good"), chunk(1, "also good")];
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
      {},
    ]);

    const result = await extractGraphFromChunks(chunks, "w2ex-stack");

    expect(result.entities.map((entity) => entity.name)).toEqual(["Gateway", "Routing"]);
    // Neither chunk failed here: the provider answered both times.
    expect(result.failedChunks).toBeUndefined();
    // The `{}` chunk is not an empty triple list, though: it has no `triplets`
    // array and no `entities` array, so it is a mangled envelope. Its remedy is
    // the prompt or the parser, not the endpoint, which is why it is counted
    // apart from the failures above.
    expect(result.mangledChunks).toBe(1);
  });

  it("counts an out-of-ontology type without touching the rejection path", async () => {
    // `gateway` is the harness default, so `strict` is off and the schema's
    // `enum` is advisory: the model's non-compliance reaches this process
    // untouched. The count makes that visible, and the triplet must STILL travel
    // the normal rejection path -- counting is a diagnostic, not a filter.
    setToolResponse([OFF_SCHEMA]);

    const result = await extractGraphFromChunks([chunk(0, "first")], "w2ex-stack", ONTOLOGY);

    expect(result.schemaViolations).toBe(1);
    const rejection = result.rejected?.[0];
    expect(rejection?.reason).toBe("UNKNOWN_ENTITY_TYPE");
    expect(rejection?.subject).toBe("Gateway");
    expect(rejection?.offendingType).toBe("PRODUCT");
    // Nothing was admitted, so nothing was written: the triplet was rejected,
    // not silently kept.
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
  });

  it("counts nothing when the provider enforces the schema itself", async () => {
    // On a strict-capable provider the request makes an out-of-ontology type
    // impossible, so a count there would report a violation the schema already
    // prevented. Re-imported against an OpenAI config for the same reason
    // `llm/strict-mode.test.ts` does it: `config` is parsed once at module load.
    vi.resetModules();
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
      return {
        ...actual,
        config: {
          ...actual.config,
          EXTRACTION_PROVIDER: "openai",
          EXTRACTION_STRICT_SCHEMA: "auto",
          OPENAI_API_KEY: "test-key-not-a-credential",
        },
      };
    });
    try {
      const strict = await import("./extraction.js");
      setToolResponse([OFF_SCHEMA]);
      const result = await strict.extractGraphFromChunks([chunk(0, "first")], "w2ex-stack", ONTOLOGY);
      // Absent, not zero: the strict path is byte-identical to what it was, and
      // that includes the result shape.
      expect("schemaViolations" in result).toBe(false);
      // The rejection path itself is unchanged -- only the diagnostic is gone.
      expect(result.rejected?.map((entry) => entry.reason)).toEqual(["UNKNOWN_ENTITY_TYPE"]);
    } finally {
      vi.doUnmock("../config.js");
      vi.resetModules();
    }
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

  it("pins the extraction prompt text the model receives", async () => {
    setToolResponse([{ triplets: [] }]);
    try {
      await extractGraphFromChunks([chunk(0, "text")], "demo");
      const prompt = lastToolPrompt();
      // Pinned on purpose: these are the exact bytes the model sees, and this
      // package deliberately departs from the oracle here (the oracle sends
      // "Give ... extracted paths.s"). The departure is registered in
      // `odd/findings/aks-spec-conformance.md`, so changing these bytes is a
      // decision with a record, not an incidental refactor.
      expect(prompt).toContain("Try to limit to the output 20 extracted triplets");
      expect(prompt.startsWith("Given the following text, extract the knowledge graph")).toBe(true);
    } finally {
      restoreToolCall();
    }
  });
});
