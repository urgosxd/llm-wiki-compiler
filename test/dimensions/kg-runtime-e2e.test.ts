/**
 * @file test/dimensions/kg-runtime-e2e.test.ts
 * @description The `kg` dimension's REAL path, end to end: one ingest attempt,
 * from raw text to rows Postgres can be asked about.
 *
 * ## Why this file exists
 *
 * Both defects it guards were found by measuring the dimension by hand, never by
 * the suite:
 *
 *   - a provider outage was swallowed into a successful commit with an empty
 *     graph, and
 *   - passage retrieval answered `ok: true` with `chunks: []` forever, because
 *     this path never wrote `document_chunks`.
 *
 * `kg-dimension.test.ts` could not catch either: it replaces the whole vendored
 * core with mocks, so it proves the adapter calls functions and nothing about
 * what those calls do. A mocked `extractGraphFromChunks` never fails, and a
 * mocked `consolidateEntityRows` never violates a foreign key. So this suite
 * imports the dimension UNMOCKED and the core UNMOCKED, and asserts on rows.
 *
 * ## Where exactly the "end" is, and why
 *
 * The only thing stubbed is the NETWORK BOUNDARY: `fetch` is replaced by the
 * vendored package's own harness, which speaks the real wire format
 * (`/embeddings`, `/chat/completions` returning a tool call). Everything from
 * that boundary inward is shipped code: the real chunker, prompt builder, tool
 * schema, triplet parser, ontology admission, consolidation SQL, and the real
 * foreign keys and unique constraints.
 *
 * Stubbing the harness's MODULES instead would reproduce the mock suite and prove
 * nothing new. Stubbing nothing would spend provider money and make the suite
 * depend on an account. The network edge is the only cut that leaves the defect
 * surface under test — and the outage case is exactly why: a 500 from the fake
 * reaches the dimension through the same code path a real one would.
 *
 * ## Why it lives under `kg-runtime-*`
 *
 * That is this role's namespace for suites that run REAL runtime behaviour
 * against a real database, beside `kg-runtime-rls-trap` and
 * `kg-runtime-savepoint-binding`. Scope ownership and semantics agree here.
 */

import { afterAll, describe, expect, it } from "vitest";

// FIRST import, and it must stay first: the vendored `config` reads `process.env`
// once at import time, so this module's side effect has to run before anything
// below reaches the provider layer. Measured, not assumed.
import "./kg-runtime-provider-env.js";

// The dimension, the reader and Postgres are imported UNMOCKED, on purpose.
import { createKgDimension } from "../../src/dimensions/kg/index.js";
import { createKgReader } from "../../src/dimensions/kg/reader.js";
import { setToolFailure, setToolResponse, toolCalls } from "@repo/kg/core/extraction-harness";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

const harness = await createKgPostgresHarness("kg-e2e");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

/** A source identity unique to this suite, so assertions cannot collide. */
const SOURCE = `https://e2e.test/${stackId}.md`;

/** One document body, short enough to produce exactly one chunk. */
const BODY = "The gateway routes embedding traffic. Nomic Embed produces vectors for every chunk.";

/** A tool-call payload naming two endpoints and one standalone entity. */
const EXTRACTION = {
  triplets: [
    {
      subject: { name: "Gateway", type: "TECHNOLOGY" },
      relation: { type: "USES" },
      object: { name: "Nomic Embed", type: "TECHNOLOGY" },
    },
  ],
  entities: [{ name: "Rate Limiting", type: "CONCEPT" }],
};

/** One document input, with the body under test. */
function input(source: string, title: string) {
  return { source, title, document: `---\ntitle: ${title}\n---\n`, body: BODY };
}

/** A dimension bound to this suite's Stack, pointing at the test database. */
function dimension() {
  return createKgDimension({ stackId, stackName: "kg-e2e", databaseUrl: testDatabaseUrl() });
}

/** Parallel-safe row counts for one Stack, so an assertion can compare before/after. */
async function rowsWritten(): Promise<{ docs: number; entities: number; edges: number }> {
  const rows = (await db.execute(
    `select
       (select count(*)::int from stack_documents where stack_id = '${stackId}') as docs,
       (select count(*)::int from ontology_entities where stack_id = '${stackId}') as entities,
       (select count(*)::int from ontology_relationships where stack_id = '${stackId}') as edges`,
  )) as { docs: number; entities: number; edges: number }[];
  return rows[0] ?? { docs: 0, entities: 0, edges: 0 };
}

/** The entity names this Stack holds, sorted for a stable comparison. */
async function entityNames(): Promise<string[]> {
  const rows = (await db.execute(
    `select name from ontology_entities where stack_id = '${stackId}' order by name`,
  )) as { name: string }[];
  return rows.map((row) => row.name);
}

describe("the kg dimension end to end", () => {
  it.skipIf(!reachable)("collects the extracted entities into rows and reports the counts", async () => {
    setToolResponse([EXTRACTION]);
    const prepared = await dimension().prepare(input(SOURCE, "E2E"));
    const committed = await dimension().commit(prepared);

    // Three nodes: both triplet endpoints, plus the standalone entity.
    expect(await entityNames()).toEqual(["Gateway", "Nomic Embed", "Rate Limiting"]);
    expect(committed.summary).toBe("kg:1 chunks, 3 entities");
    // The edge resolved, which only happens after both endpoints are consolidated.
    expect((await rowsWritten()).edges).toBe(1);
  }, 60_000);

  it.skipIf(!reachable)("is idempotent: a re-ingest of identical bytes adds no rows", async () => {
    const before = await rowsWritten();
    await dimension().commit(await dimension().prepare(input(SOURCE, "E2E")));

    // `unique_hash_per_stack` collapses the document and consolidation upserts by
    // name, so a replay must not fork a second copy of the graph.
    expect(await rowsWritten()).toEqual(before);
  }, 60_000);

  it.skipIf(!reachable)("refuses a text query instead of answering an empty list", async () => {
    // The capability this dimension lacks must not look like a search that found
    // nothing: that is the defect this pins shut.
    const result = await createKgReader({ stackId, databaseUrl: testDatabaseUrl() }).read({
      text: "how is Gateway connected to Nomic Embed",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  }, 60_000);

  it.skipIf(!reachable)("serves the entities and the walk through the reader", async () => {
    const reader = createKgReader({ stackId, databaseUrl: testDatabaseUrl() });

    const listed = await reader.read({ limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.entities.map((entity) => entity.name).sort()).toEqual([
      "Gateway",
      "Nomic Embed",
      "Rate Limiting",
    ]);

    const walked = await reader.read({ name: "Gateway", depth: 2 });
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    // This reads the edge THIS suite's ingest wrote, which is the point of
    // asserting here rather than against hand-seeded rows.
    expect(walked.value.relationships).toEqual([
      { from: "Gateway", to: "Nomic Embed", kind: "USES", confidence: expect.any(Number) },
    ]);
  }, 60_000);
});

describe("the kg dimension end to end when the provider is down", () => {
  it.skipIf(!reachable)("fails the run and writes nothing, which is the atomic contract", async () => {
    const before = await rowsWritten();
    const callsBefore = toolCalls();

    setToolFailure();
    await expect(
      dimension().prepare(input(`${SOURCE}?outage`, "Outage")),
    ).rejects.toThrow(/extraction failed for all/);

    // Retried before giving up: one chunk, three attempts.
    expect(toolCalls() - callsBefore).toBe(3);
    // And nothing landed, because `prepare` never returned a handle to commit.
    expect(await rowsWritten()).toEqual(before);
  }, 60_000);
});

describe("the kg dimension end to end keeps Stacks apart", () => {
  it.skipIf(!reachable)("writes into its own Stack and never into another", async () => {
    const other = await createKgPostgresHarness("kg-e2e-other");
    try {
      if (!other.reachable) return;
      const otherDimension = createKgDimension({
        stackId: other.stackId,
        stackName: "kg-e2e-other",
        databaseUrl: testDatabaseUrl(),
      });

      setToolResponse([EXTRACTION]);
      const prepared = await otherDimension.prepare(
        input(`https://e2e.test/other-${other.stackId}.md`, "Other"),
      );
      await otherDimension.commit(prepared);

      const foreign = (await other.db.execute(
        `select name from ontology_entities where stack_id = '${other.stackId}' order by name`,
      )) as { name: string }[];
      // Same body and extraction, so the same names -- in ITS Stack.
      expect(foreign.map((row) => row.name)).toEqual(["Gateway", "Nomic Embed", "Rate Limiting"]);
      // This suite's Stack still holds its own three, not six.
      expect(await entityNames()).toHaveLength(3);
    } finally {
      await other.cleanup();
    }
  }, 90_000);
});
