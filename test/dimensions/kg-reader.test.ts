/**
 * @file test/dimensions/kg-reader.test.ts
 * @description The `kg` dimension's READER, exercised through the
 * `DimensionReader` port rather than through its underlying queries.
 *
 * WHY THE PORT AND NOT THE QUERIES. `core/graph_read.ts` is already covered by
 * `kg-read-service.test.ts`. What is new here is the TRANSLATION: an AKS entity
 * becoming a `ReadEntity`, a walk step becoming a `ReadRelationship`, and a coded
 * graph failure becoming a coded dimension failure. A test that called the queries
 * directly would not exercise any of that.
 *
 * Entity and relationship reads are asserted against real Postgres. Chunk
 * retrieval is deliberately NOT asserted here: it needs a live embedding provider,
 * and stubbing it would test the stub.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { consolidateEntityRows, consolidateRelationshipRows, registerDocumentRow } from "llmwiki-kg";
import { createKgReader } from "../../src/dimensions/kg/reader.js";
import { expectNamedLookupContract } from "../fixtures/reader-assertions.js";

const harness = await createKgPostgresHarness("kg-reader");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

/** A reader bound to this suite's stack, using its connection. */
function reader() {
  return createKgReader({
    stackId,
    databaseUrl: process.env.LLMWIKI_TEST_DATABASE_URL ?? "postgresql://aks:aks@localhost:5434/aks",
  });
}

/** Seed one document whose extraction yields two entities and one edge. */
async function seedGraph(): Promise<void> {
  await db.transaction(async (tx) => {
    const documentId = await registerDocumentRow(tx, {
      stackId,
      source: `https://reader.test/${stackId}.md`,
      body: "Alpha uses Beta.",
      title: "Reader",
    });
    const nameToId = await consolidateEntityRows(tx, stackId, documentId, [
      { name: "Alpha", type: "system", description: "first entity", confidence: 0.9, properties: {} },
      { name: "Beta", type: "tool", description: "second entity", confidence: 0.5, properties: {} },
    ]);
    await consolidateRelationshipRows(
      tx,
      stackId,
      [{
        fromEntityName: "Alpha",
        toEntityName: "Beta",
        type: "uses",
        description: "",
        confidence: 0.8,
        sourceChunkIndices: [0],
      }],
      nameToId,
    );
  });
}

describe("the kg dimension as a DimensionReader", () => {
  it("is named kg, so a caller can address it like its write side", () => {
    expect(reader().name).toBe("kg");
  });

  it("maps graph entities onto the dimension-neutral shape", async () => {
    if (!reachable) return;
    await seedGraph();

    const result = await reader().read({ limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const alpha = result.value.entities.find((entity) => entity.name === "Alpha");
    // `type` becomes `kind`, and confidence survives: a caller ranking across
    // dimensions needs both.
    expect(alpha?.kind).toBe("system");
    expect(alpha?.confidence).toBeCloseTo(0.9, 5);
    expect(alpha?.description).toBe("first entity");
  }, 30_000);

  it("finds one entity by name and reports not_found as a code", async () => {
    if (!reachable) return;
    // The lookup contract is asserted identically on both dimensions, so a change
    // to the port's failure semantics fails BOTH suites rather than one.
    await expectNamedLookupContract(reader(), "Alpha", "Alpha");
  }, 30_000);

  it("returns typed edges only when a walk is actually requested", async () => {
    if (!reachable) return;
    const readerInstance = reader();

    // A name without a depth is a lookup, not a walk: no edges should appear.
    const lookup = await readerInstance.read({ name: "Alpha" });
    expect(lookup.ok && lookup.value.relationships).toHaveLength(0);

    const walked = await readerInstance.read({ name: "Alpha", depth: 2 });
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    expect(walked.value.relationships[0]).toMatchObject({
      from: "Alpha",
      to: "Beta",
      kind: "uses",
    });
  }, 30_000);

  it("narrows by kind, which is the graph's entity type", async () => {
    if (!reachable) return;
    const result = await reader().read({ kinds: ["tool"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities.map((entity) => entity.name)).toEqual(["Beta"]);
  }, 30_000);

  it("does not return relationships for a source that has none", async () => {
    if (!reachable) return;
    // A plain listing asks for no anchor, so there is nothing to walk from.
    const result = await reader().read({ limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relationships).toHaveLength(0);
  }, 30_000);
});
