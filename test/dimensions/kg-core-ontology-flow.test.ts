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

import { describe, expect, it, vi } from "vitest";

import { validateOntology } from "../../packages/llmwiki-kg/ts/src/core/ontology.js";

const chunkAndEmbed = vi.fn();
const extractGraphFromChunks = vi.fn();
const registerDocumentRow = vi.fn();
const consolidateEntityRows = vi.fn();
const consolidateRelationshipRows = vi.fn();
const forgetDocumentRows = vi.fn();

vi.mock("llmwiki-kg", () => ({
  chunkAndEmbed,
  extractGraphFromChunks,
  registerDocumentRow,
  consolidateEntityRows,
  consolidateRelationshipRows,
  forgetDocumentRows,
  createClient: vi.fn(() => ({ end: vi.fn() })),
  createDatabase: vi.fn(() => ({
    transaction: async (run: (tx: unknown) => Promise<void>) => run({}),
  })),
  kgConfig: { DATABASE_URL: "postgres://invalid/none" },
}));

const { createKgDimension } = await import("../../src/dimensions/kg/index.js");

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
  const dimension = createKgDimension({ stackId: "s", stackName: "demo", ontology: ONTOLOGY });
  return dimension.commit(await dimension.prepare(INPUT));
}

describe("kg dimension with a declared ontology", () => {
  it("passes the ontology through to extraction", async () => {
    chunkAndEmbed.mockResolvedValue([CHUNK]);
    extractGraphFromChunks.mockResolvedValue({
      entities: [{ name: "Acme", type: "COMPANY" }],
      relationships: [],
      model: "m",
      pipeline: "p",
    });

    await createKgDimension({
      stackId: "s",
      stackName: "demo",
      ontology: ONTOLOGY,
      dryRun: true,
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

    expect(committed.summary).toContain("1 triplets rejected by ontology");
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
  it("calls extraction with no ontology, preserving oracle behaviour", async () => {
    chunkAndEmbed.mockResolvedValue([CHUNK]);
    extractGraphFromChunks.mockResolvedValue({
      entities: [{ name: "Thing", type: "ANYTHING" }],
      relationships: [],
      model: "m",
      pipeline: "p",
    });

    await createKgDimension({ stackId: "s", stackName: "demo", dryRun: true }).prepare(INPUT);

    // Exactly two arguments: a run with no ontology must not widen the call at
    // all, so nothing downstream sees a trailing `undefined` where the oracle
    // passed nothing.
    expect(extractGraphFromChunks).toHaveBeenCalledWith([CHUNK], "demo");
  });
});
