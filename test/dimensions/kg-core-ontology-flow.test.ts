/**
 * @file test/dimensions/kg-core-ontology-flow.test.ts
 * @description The declared ontology governs the real kg dimension end to end.
 *
 * WHY THIS FILE EXISTS. The ontology module has unit tests, but a unit test
 * cannot show that a JSON file actually reaches the extraction call, or that a
 * rejected triplet stops before Postgres instead of merely being counted. This
 * suite drives `createKgDimension` with a mocked vendored core and asserts the
 * two things a caller cares about: the declared types are what the model is
 * asked for, and nothing outside them is reported as a successful write.
 *
 * The vendored core is replaced wholesale, so this needs no Postgres, no provider
 * credentials, and no network. What is under test is the wiring, not the model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { validateOntology } from "@repo/kg/core/ontology";

const chunkAndEmbed = vi.fn();
const extractGraphFromChunks = vi.fn();
const registerDocumentRow = vi.fn();
const consolidateEntityRows = vi.fn();
const consolidateRelationshipRows = vi.fn();
const forgetDocumentRows = vi.fn();

vi.mock("@repo/kg", async () => {
  // The ontology reader is the REAL one: the dimension's default `loadOntology`
  // routes through it, and a stub would make the import fail rather than let the
  // suite state its own `loadOntology`. Tests may import packages freely.
  const core = await import("@repo/kg/core-index");
  const { prepareCoreExports } = await import("./kg-core-mock.js");
  return {
    chunkAndEmbed,
    extractGraphFromChunks,
    registerDocumentRow,
    consolidateEntityRows,
    consolidateRelationshipRows,
    forgetDocumentRows,
    createClient: vi.fn(() => ({ end: vi.fn() })),
    createDatabase: vi.fn(() => ({
      // The handle carries `execute` because `commit` records the run's extracted
      // chunk hashes on the caller's own handle, and that ledger write is a statement
      // issued on it rather than a barrel function this suite can replace.
      transaction: async (run: (tx: unknown) => Promise<void>) =>
        run({ execute: vi.fn(async () => []) }),
    })),
    ...prepareCoreExports(core, "postgres://invalid/none"),
  };
});

const { createKgDimension } = await import("../../packages/wiki/src/dimensions/kg/index.js");

/** The declaration under test. */
const ONTOLOGY = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["SUPPLIES"],
  subtypes: [],
});

/** One chunk, shaped like the vendored core's. */
const CHUNK = { documentId: "d", stackId: "s", chunkIndex: 0, content: "body" };

/** The source every case ingests. */
const INPUT = { source: "src/a.md", title: "A", body: "body" };

/**
 * Drives one full prepare+commit cycle against a stubbed extraction result.
 *
 * The three summary assertions differ only in the extraction result they feed
 * in, so the sequencing lives here once rather than being restated per case.
 *
 * @param extraction - What the vendored extractor returns for this run.
 * @returns The committed write the caller's assertions inspect.
 */
async function commitWith(extraction: Record<string, unknown>) {
  chunkAndEmbed.mockResolvedValue([CHUNK]);
  extractGraphFromChunks.mockResolvedValue({ model: "m", pipeline: "p", ...extraction });
  const dimension = createKgDimension({
    stackId: "s",
    stackName: "demo",
    ontology: ONTOLOGY,
    loadOntology: async () => undefined,
    // Injected for the same reason: the default ledger reader opens the graph
    // database, and this suite replaces the vendored core wholesale.
    readExtractedChunkHashes: async () => new Set<string>(),
    // The provider layer is replaced here, so no embedding backend is reported:
    // the default resolver would consult the machine's own provider environment.
    describeEmbeddingBackend: () => undefined,
  });
  return dimension.commit(await dimension.prepare(INPUT));
}

beforeEach(() => {
  // The model the operator named: `prepare` refuses a model nobody chose, so
  // this suite states that wiring too and measures the ontology path instead.
  vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "test-model-not-real");
  // The summary now carries the rejected-row count the WRITE reported (S6), so the stub
  // answers in the shape the real write returns instead of `undefined`.
  consolidateRelationshipRows.mockResolvedValue({ written: 0, collisions: [], rejectedRows: 0 });
  consolidateEntityRows.mockResolvedValue(
    Object.assign(new Map([["Acme", "id-acme"]]), { rejectedRows: 0 }),
  );
});

describe("kg dimension with a declared ontology", () => {
  it("passes the ontology through to extraction", async () => {
    chunkAndEmbed.mockResolvedValue([CHUNK]);
    extractGraphFromChunks.mockResolvedValue({
      entities: [{ name: "Acme", type: "COMPANY" }],
      relationships: [],
      model: "m",
      pipeline: "p",
    });

    // Real path on purpose: this asserts what extraction RECEIVES, and a detect-only
    // run no longer extracts. The core is a stub, so the assertion costs nothing.
    await createKgDimension({
      stackId: "s",
      stackName: "demo",
      ontology: ONTOLOGY,
      // Same injection as `commitWith`: nothing was extracted for this source yet,
      // so the write the assertion reads is reached with every chunk pending.
      readExtractedChunkHashes: async () => new Set<string>(),
      describeEmbeddingBackend: () => undefined,
    }).prepare(INPUT);

    expect(extractGraphFromChunks).toHaveBeenCalledWith([CHUNK], "demo", ONTOLOGY);
  });

  it("reports rejections in the commit summary instead of hiding them", async () => {
    const committed = await commitWith({
      entities: [{ name: "Acme", type: "COMPANY" }],
      relationships: [],
      rejected: [
        { subject: "Acme", relation: "ACQUIRED", object: "Globex", reason: "UNKNOWN_RELATIONSHIP_TYPE", offendingType: "ACQUIRED" },
      ],
    });

    expect(committed.summary).toContain("1 triplet rejected by ontology");
  });

  it("keeps the summary clean when nothing was rejected", async () => {
    const committed = await commitWith({
      entities: [{ name: "Acme", type: "COMPANY" }],
      relationships: [],
      rejected: [],
    });

    expect(committed.summary).not.toContain("rejected");
  });
});

describe("kg dimension without an ontology", () => {
  it("calls extraction with the default ontology when the Stack declares none", async () => {
    chunkAndEmbed.mockResolvedValue([CHUNK]);
    extractGraphFromChunks.mockResolvedValue({
      entities: [{ name: "Thing", type: "ANYTHING" }],
      relationships: [],
      model: "m",
      pipeline: "p",
    });

    // Real path on purpose: same reason as the case above — a detect-only run reports
    // counts instead of calling extraction, so it cannot show which ontology was passed.
    await createKgDimension({
      stackId: "s",
      stackName: "demo",
      loadOntology: async () => undefined,
      readExtractedChunkHashes: async () => new Set<string>(),
      describeEmbeddingBackend: () => undefined,
    }).prepare(INPUT);

    // Exactly three arguments, the third being the default ontology. This used to
    // assert a two-argument call, which is the behaviour that made an undeclared
    // Stack's `type` column a free-text field.
    expect(extractGraphFromChunks).toHaveBeenCalledWith(
      [CHUNK],
      "demo",
      expect.objectContaining({ entityTypes: expect.arrayContaining(["COMPANY"]) }),
    );
  });
});
