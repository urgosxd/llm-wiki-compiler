/**
 * @file test/dimensions/kg-core-ontology-read.test.ts
 * @description The kg dimension loads a Stack's stored ontology before extracting.
 *
 * WHY THIS FILE EXISTS. Slice 2 shipped a reader and a writer with nothing in
 * between: the column could be populated by `POST /stacks` and read by the HTTP
 * ingest route, but the dimension path — the one the compiler actually runs —
 * never looked at it. A Stack configured through the API was therefore unenforced
 * whenever the document arrived through the dimension.
 *
 * The four behaviours that decide whether closing that gap is safe:
 *
 *   - no declaration means the oracle's two-argument call, so an unconfigured
 *     Stack behaves exactly as it did before this feature existed;
 *   - a stored declaration is loaded and passed, changing what gets extracted;
 *   - an explicit option still wins, because that is how a caller overrides the
 *     database without editing it;
 *   - a malformed declaration fails the run instead of quietly falling back to
 *     permissive extraction. Partial enforcement is worse than none: an operator
 *     who declared a schema and got default behaviour without being told would
 *     believe the graph is constrained when it is not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const chunkAndEmbed = vi.fn();
const extractGraphFromChunks = vi.fn();
const createClient = vi.fn(() => ({ end: vi.fn() }));
const createDatabase = vi.fn(() => ({
  transaction: async (run: (tx: unknown) => Promise<void>) => run({}),
}));

// `readStackOntology` is deliberately the REAL implementation, not a stub: the
// property under test is that a stored declaration is validated and a malformed
// one fails the run, and a stub could only assert that the dimension called
// something. Tests may import packages freely; only `src/` may not.
vi.mock("llmwiki-kg", async () => {
  const core = await import("../../packages/llmwiki-kg/ts/src/core-index.js");
  return {
    chunkAndEmbed,
    extractGraphFromChunks,
    registerDocumentRow: vi.fn(),
    consolidateEntityRows: vi.fn(),
    consolidateRelationshipRows: vi.fn(),
    forgetDocumentRows: vi.fn(),
    createClient,
    createDatabase,
    readStackOntology: core.readStackOntology,
    OntologyError: core.OntologyError,
    kgConfig: { DATABASE_URL: "postgres://invalid/none" },
  };
});

const { createKgDimension } = await import("../../src/dimensions/kg/index.js");
const { OntologyError } = await import(
  "../../packages/llmwiki-kg/ts/src/core/ontology.js"
);

/** The declaration a configured Stack carries. */
const DECLARATION = {
  entityTypes: ["COMPANY"],
  relationshipTypes: ["SUPPLIES"],
  subtypes: [],
};

/** A validated ontology, in the shape `readStackOntology` returns. */
const ONTOLOGY = { ...DECLARATION, parentsOf: new Map() };

const INPUT = { source: "src/a.md", title: "A", body: "body" };

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

/** Build a dimension whose stored-ontology read is stubbed. */
function build(loadOntology: () => Promise<unknown>) {
  return createKgDimension({
    stackId: "s",
    stackName: "demo",
    dryRun: true,
    loadOntology,
  });
}

beforeEach(() => {
  // Reset call history only. `clearAllMocks` would also drop the `createDatabase`
  // and `createClient` implementations this suite installs at module scope, and a
  // suite whose assertions read call history must not inherit the previous test's.
  chunkAndEmbed.mockReset();
  extractGraphFromChunks.mockReset();
  createClient.mockReset();
  createClient.mockReturnValue({ end: vi.fn() });
  createDatabase.mockReset();
  createDatabase.mockReturnValue({
    transaction: async (run: (tx: unknown) => Promise<void>) => run({}),
  });
  stubCore();
});

describe("kg dimension ontology wiring", () => {
  it("calls extraction with exactly two arguments when the Stack has no declaration", async () => {
    await build(async () => undefined).prepare(INPUT);

    expect(extractGraphFromChunks).toHaveBeenCalledWith(expect.anything(), "demo");
  });

  it("passes the Stack's stored declaration as the third argument", async () => {
    await build(async () => ONTOLOGY).prepare(INPUT);

    expect(extractGraphFromChunks).toHaveBeenCalledWith(expect.anything(), "demo", ONTOLOGY);
  });

  it("reads the declaration for the dimension's own Stack", async () => {
    const loadOntology = vi.fn(async () => undefined);

    await createKgDimension({
      stackId: "stack-under-test",
      stackName: "demo",
      dryRun: true,
      loadOntology,
    }).prepare(INPUT);

    expect(loadOntology).toHaveBeenCalledWith("stack-under-test", undefined);
  });

  it("fails the run rather than silently falling back when the declaration is malformed", async () => {
    // A real malformed document, so the failure comes from the actual validator
    // and not from a stub that was told to throw.
    const dimension = build(async () => ({ entityTypes: [], relationshipTypes: [] }));

    await expect(dimension.prepare(INPUT)).rejects.toThrow(OntologyError);
    expect(extractGraphFromChunks).not.toHaveBeenCalled();
  });

  it("fails before spending an embedding call when the declaration is malformed", async () => {
    const dimension = build(async () => ({ entityTypes: [], relationshipTypes: [] }));

    await expect(dimension.prepare(INPUT)).rejects.toThrow(OntologyError);
    expect(chunkAndEmbed).not.toHaveBeenCalled();
  });

  it("prefers an explicitly supplied ontology over the stored one", async () => {
    const loadOntology = vi.fn(async () => undefined);
    const explicit = { ...DECLARATION, parentsOf: new Map() };

    await createKgDimension({
      stackId: "s",
      stackName: "demo",
      dryRun: true,
      ontology: explicit,
      loadOntology,
    }).prepare(INPUT);

    expect(loadOntology).not.toHaveBeenCalled();
    expect(extractGraphFromChunks).toHaveBeenCalledWith(expect.anything(), "demo", explicit);
  });
});

describe("kg dimension default ontology source", () => {
  it("reads the Stack's declaration without any caller wiring it", async () => {
    // The guarantee this feature exists for: a Stack configured through
    // `POST /stacks` is enforced by the compiler, with no caller having to know
    // the ontology column exists. The read is stubbed to a real declaration so
    // this asserts the DEFAULT source is reachable, not that wiring happens to
    // be present at one call site.
    const loadStoredOntology = vi.fn(async () => DECLARATION);
    vi.doMock("../../src/dimensions/kg/ontology-store.js", () => ({ loadStoredOntology }));
    vi.resetModules();

    const { createKgDimension: freshCreate } = await import(
      "../../src/dimensions/kg/index.js"
    );
    stubCore();

    await freshCreate({ stackId: "s", stackName: "demo", dryRun: true }).prepare(INPUT);

    expect(loadStoredOntology).toHaveBeenCalledWith("s", undefined);
    expect(extractGraphFromChunks).toHaveBeenCalledWith(
      expect.anything(),
      "demo",
      expect.objectContaining({ entityTypes: ["COMPANY"] }),
    );

    vi.doUnmock("../../src/dimensions/kg/ontology-store.js");
    vi.resetModules();
  });
});
