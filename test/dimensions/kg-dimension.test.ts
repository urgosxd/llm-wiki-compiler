/**
 * @file test/dimensions/kg-dimension.test.ts
 * @description Unit tests for `createKgDimension` — the adapter that maps the
 * vendored knowledge-graph core onto the dimension port.
 *
 * WHY THIS FILE EXISTS. The coordinator suite exercises the port with a mock
 * dimension, and the activation suite builds the real KG dimension but only in
 * `dryRun`, where `commit` returns before touching a database. Neither ever ran
 * the code path that actually writes a graph. That left the adapter's three
 * decisions unverified: what document id it derives, what it reports as
 * unchanged, and whether `commit` reaches Postgres when it is not a dry run.
 *
 * The vendored core is replaced wholesale so these tests need no Postgres, no
 * provider credentials, and no network. What is under test is the ADAPTER's
 * sequencing and reporting, not the extraction model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** One chunk, shaped like the vendored `ChunkResult` the adapter consumes. */
const CHUNK = { text: "body", embedding: [0.1], index: 0 };
/** One extracted entity, shaped like the vendored extraction result. */
const ENTITY = { name: "Alpha", kind: "concept" };
/** One extracted relationship between two entities. */
const RELATIONSHIP = { from: "Alpha", to: "Beta", kind: "relates" };

const chunkAndEmbed = vi.fn();
const extractGraphFromChunks = vi.fn();
const createClient = vi.fn();
const createDatabase = vi.fn();
const consolidateEntityRows = vi.fn();
const consolidateRelationshipRows = vi.fn();
const registerDocumentRow = vi.fn();

// The adapter imports the barrel by package name, which the vitest alias maps
// to `core-index.ts`. Mocking that same specifier intercepts the adapter's view.
vi.mock("llmwiki-kg", async () => {
  // The ontology reader is the REAL one: the dimension's default `loadOntology`
  // routes through it, and a stub would make the import fail rather than let the
  // suite state its own `loadOntology`. Tests may import packages freely.
  const core = await import("../../packages/llmwiki-kg/ts/src/core-index.js");
  return {
    chunkAndEmbed,
    extractGraphFromChunks,
    createClient,
    createDatabase,
    consolidateEntityRows,
    consolidateRelationshipRows,
    registerDocumentRow,
    kgConfig: { DATABASE_URL: "postgres://from-config" },
    readStackOntology: core.readStackOntology,
    defaultOntology: core.defaultOntology,
  };
});

const { createKgDimension } = await import("../../src/dimensions/kg/index.js");

/** Build the dimension under test with a stable stack binding. */
function dimension(options: { dryRun?: boolean; databaseUrl?: string } = {}) {
  return createKgDimension({
    stackId: "stack-1",
    stackName: "Stack One",
    ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    // This suite is about sequencing, not the ontology read. Stating "no stored
    // declaration" keeps it free of a database without pretending the default
    // reader does not exist — the default is what a real run uses.
    loadOntology: async () => undefined,
  }) as unknown as ReturnType<typeof createKgDimension>;
}

/** A dimension input with distinct source and body, as an ingest would supply. */
const INPUT = { source: "https://example.test/a", title: "A", document: "# A\nbody", body: "body" };

beforeEach(() => {
  vi.clearAllMocks();
  chunkAndEmbed.mockResolvedValue([CHUNK]);
  extractGraphFromChunks.mockResolvedValue({ entities: [ENTITY], relationships: [RELATIONSHIP] });
  createClient.mockReturnValue({ end: vi.fn().mockResolvedValue(undefined) });
  createDatabase.mockReturnValue({ transaction: (fn: (tx: unknown) => Promise<void>) => fn({}) });
  consolidateEntityRows.mockResolvedValue(new Map([["Alpha", "id-alpha"]]));
  consolidateRelationshipRows.mockResolvedValue(undefined);
  // Postgres owns the document id; the adapter must adopt it, never invent it.
  registerDocumentRow.mockResolvedValue("row-id-from-postgres");
});

describe("the kg dimension adapter", () => {
  it("is named kg so the coordinator can order and key it", () => {
    expect(dimension().name).toBe("kg");
  });

  it("labels in-memory chunks by source alone, so editing a body keeps the label", async () => {
    const first = await dimension().prepare(INPUT);
    const sameSourceNewBody = await dimension().prepare({ ...INPUT, body: "other" });

    const labelOf = (prepared: Awaited<ReturnType<ReturnType<typeof dimension>["prepare"]>>): string =>
      (prepared.handle as { documentId: string }).documentId;

    // Metadata only: the authoritative id is assigned by Postgres at commit, so a
    // content-derived label would be a second, divergent identity for one source.
    expect(labelOf(first)).toBe(labelOf(sameSourceNewBody));
    expect(labelOf(first)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("takes the document id Postgres assigns instead of inventing one", async () => {
    const prepared = await dimension().prepare(INPUT);
    await dimension().commit(prepared);

    // The foreign key `entity_source_documents.document_id` references this row, so
    // consolidation must receive the REAL id, not a digest that merely looks like a UUID.
    expect(registerDocumentRow).toHaveBeenCalledWith(
      {},
      { stackId: "stack-1", source: INPUT.source, body: INPUT.body, title: INPUT.title },
    );
    expect(consolidateEntityRows).toHaveBeenCalledWith(
      {}, "stack-1", "row-id-from-postgres", [ENTITY],
    );
  });

  it("reports unchanged when extraction yields no chunks, without writing", async () => {
    chunkAndEmbed.mockResolvedValue([]);
    extractGraphFromChunks.mockResolvedValue({ entities: [], relationships: [] });
    const prepared = await dimension().prepare(INPUT);

    expect(prepared.unchanged).toBe(true);
    expect(consolidateEntityRows).not.toHaveBeenCalled();
  });

  it("passes the stack binding to chunking and extraction", async () => {
    await dimension().prepare(INPUT);

    expect(chunkAndEmbed).toHaveBeenCalledWith(INPUT.body, "stack-1", expect.stringMatching(/^[0-9a-f]{32}$/));
    // The third argument is the ontology in force: the Stack's own declaration
    // when it has one, the documented default otherwise. Either way extraction is
    // never called with only the name, which is how an undeclared Stack used to
    // reach the parser with nothing to check against.
    expect(extractGraphFromChunks).toHaveBeenCalledWith(
      expect.anything(),
      "Stack One",
      expect.objectContaining({ entityTypes: expect.any(Array) }),
    );
  });

  it("writes both node kinds in one transaction and reports the counts", async () => {
    const prepared = await dimension().prepare(INPUT);
    const committed = await dimension().commit(prepared);

    expect(createClient).toHaveBeenCalledWith("postgres://from-config", expect.any(Number));
    // Parent row first: the FK rejects a contribution row for a missing document.
    expect(registerDocumentRow.mock.invocationCallOrder[0]).toBeLessThan(
      consolidateEntityRows.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(consolidateEntityRows).toHaveBeenCalledWith({}, "stack-1", expect.any(String), [ENTITY]);
    expect(consolidateRelationshipRows).toHaveBeenCalledWith({}, "stack-1", [RELATIONSHIP], expect.any(Map));
    expect(committed.summary).toBe("kg:1 chunks, 1 entities");
    expect(committed.idempotencyKey).toBe("kg:row-id-from-postgres");
  });

  it("prefers an explicit database url over the vendored config default", async () => {
    const prepared = await dimension({ databaseUrl: "postgres://explicit" }).prepare(INPUT);
    await dimension({ databaseUrl: "postgres://explicit" }).commit(prepared);

    expect(createClient).toHaveBeenCalledWith("postgres://explicit", expect.any(Number));
  });

  it("closes the database client even when the transaction fails", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    createClient.mockReturnValue({ end });
    createDatabase.mockReturnValue({ transaction: () => Promise.reject(new Error("consolidation failed")) });
    const prepared = await dimension().prepare(INPUT);

    await expect(dimension().commit(prepared)).rejects.toThrow("consolidation failed");
    expect(end).toHaveBeenCalled();
  });

  it("writes nothing in dry run but still reports what it would have written", async () => {
    const prepared = await dimension({ dryRun: true }).prepare(INPUT);
    const committed = await dimension({ dryRun: true }).commit(prepared);

    expect(createClient).not.toHaveBeenCalled();
    expect(committed.summary).toBe("kg:dry-run(1 chunks, 1 entities)");
  });

  it("discards without touching the graph, since prepare writes no rows", async () => {
    const prepared = await dimension().prepare(INPUT);
    await dimension().discard(prepared);

    expect(createClient).not.toHaveBeenCalled();
    expect(consolidateEntityRows).not.toHaveBeenCalled();
  });
});
