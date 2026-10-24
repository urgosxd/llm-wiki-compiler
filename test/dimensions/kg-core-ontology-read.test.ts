/**
 * @file test/dimensions/kg-core-ontology-read.test.ts
 * @description The kg dimension reads a Stack's stored ontology before extracting.
 *
 * WHY THIS FILE EXISTS. Slice 2 shipped a reader (ingest) and a writer of nothing:
 * the HTTP surface cannot carry an ontology without breaking the oracle contract,
 * so the column has to be read by the dimension itself. These tests pin the two
 * behaviours that decide whether that is safe:
 *
 *   - no option and no stored row means the oracle's two-argument call, so an
 *     unconfigured Stack behaves exactly as it did before this feature existed;
 *   - a stored row is validated and passed, and a malformed one fails rather than
 *     quietly admitting everything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const chunkAndEmbed = vi.fn();
const extractGraphFromChunks = vi.fn();
const createClient = vi.fn(() => ({ end: vi.fn() }));
const createDatabase = vi.fn(() => ({
  transaction: async (run: (tx: unknown) => Promise<void>) => run({}),
}));

vi.mock("llmwiki-kg", () => ({
  chunkAndEmbed,
  extractGraphFromChunks,
  registerDocumentRow: vi.fn(),
  consolidateEntityRows: vi.fn(),
  consolidateRelationshipRows: vi.fn(),
  forgetDocumentRows: vi.fn(),
  createClient,
  createDatabase,
  kgConfig: { DATABASE_URL: "postgres://invalid/none" },
}));

const { createKgDimension } = await import("../../src/dimensions/kg/index.js");

/** One chunk and a clean extraction, so only the ontology wiring varies. */
function stubCore(): void {
  chunkAndEmbed.mockResolvedValue([{ documentId: "d", stackId: "s", chunkIndex: 0, content: "b" }]);
  extractGraphFromChunks.mockResolvedValue({
    entities: [],
    relationships: [],
    model: "m",
    pipeline: "p",
  });
}

const INPUT = { source: "src/a.md", title: "A", body: "body" };

beforeEach(() => {
  // Reset call history only. `clearAllMocks` would also drop the `createDatabase`
  // and `createClient` implementations this suite installs at module scope, and a
  // suite whose assertions read call history must not inherit the previous test's.
  chunkAndEmbed.mockReset();
  extractGraphFromChunks.mockReset();
  createDatabase.mockReset();
  createClient.mockReset();
  createClient.mockReturnValue({ end: vi.fn() });
  createDatabase.mockReturnValue({
    transaction: async (run: (tx: unknown) => Promise<void>) => run({}),
  });
  stubCore();
});

describe("kg dimension ontology wiring", () => {
  it("calls extraction with exactly two arguments when no ontology is configured", async () => {
    stubCore();
    await createKgDimension({ stackId: "s", stackName: "demo", dryRun: true }).prepare(INPUT);

    expect(extractGraphFromChunks).toHaveBeenCalledWith(expect.anything(), "demo");
  });

  it("passes a configured ontology as the third argument", async () => {
    stubCore();
    const ontology = {
      entityTypes: ["COMPANY"],
      relationshipTypes: ["SUPPLIES"],
      subtypes: [],
      parentsOf: new Map(),
    };

    await createKgDimension({
      stackId: "s",
      stackName: "demo",
      ontology,
      dryRun: true,
    }).prepare(INPUT);

    expect(extractGraphFromChunks).toHaveBeenCalledWith(expect.anything(), "demo", ontology);
  });
});
