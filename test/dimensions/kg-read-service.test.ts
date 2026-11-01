/**
 * @file test/dimensions/kg-read-service.test.ts
 * @description The graph can be READ without going through Express.
 *
 * WHY THIS IS THE POINT. `readEntities`, `readEntityByName`, and `traverseGraph`
 * used to take `(req, res, tx)`, so the only way to read the graph was to speak
 * HTTP — even from code already in process. That blocked the `kg` dimension, the
 * MCP server, and any test that wants the answer rather than a status code.
 *
 * These tests import the read layer DIRECTLY, with no server and no request. If
 * they pass only through a handler, the extraction did not happen.
 *
 * They run against real Postgres because the queries are the thing under test, and
 * a mock cannot tell a valid `any(...)` array cast from a broken one — the exact
 * defect this refactor introduced once and a fidelity test caught.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { expectNotFoundCode } from "../fixtures/reader-assertions.js";
import {
  DEFAULT_TEST_DATABASE_URL,
  TEST_DATABASE_URL_ENV_VAR,
  testDatabaseUrl,
} from "../fixtures/test-database.js";
import {
  consolidateEntityRows,
  consolidateRelationshipRows,
  readEntities,
  readEntityByName,
  registerDocumentRow,
  traverseGraph,
} from "llmwiki-kg";

const harness = await createKgPostgresHarness("kg-read");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

/**
 * Seed one document whose extraction yields a small connected graph.
 *
 * Two entities and one edge are the minimum that makes a walk distinguishable from
 * a lookup: with a single node, "walk" and "get entity" return the same thing.
 */
async function seedGraph(): Promise<void> {
  await db.transaction(async (tx) => {
    const documentId = await registerDocumentRow(tx, {
      stackId,
      source: `https://read.test/${stackId}.md`,
      body: "Alpha uses Beta.",
      title: "Read",
    });
    const nameToId = await consolidateEntityRows(tx, stackId, documentId, [
      { name: "Alpha", type: "system", description: "first", confidence: 0.9, properties: {} },
      { name: "Beta", type: "tool", description: "second", confidence: 0.5, properties: {} },
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

describe("the graph read layer answers without an HTTP request", () => {
  // `skipIf` rather than an early `return;` inside each body: with no database the
  // suite must report SKIPPED, because a body that returns early is recorded as a
  // pass and proves nothing about the read layer it claims to exercise.
  it.skipIf(!reachable)("lists entities for a stack, highest confidence first", async () => {
    await seedGraph();

    const result = await db.transaction((tx) =>
      readEntities(tx, { stackId, domain: null, type: null, minConfidence: 0, limit: 50 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((entity) => entity.name);
    // The ordering is part of the oracle contract, not incidental.
    expect(names).toEqual(["Alpha", "Beta"]);
  }, 30_000);

  it.skipIf(!reachable)("filters by kind, which is the graph's `type` column", async () => {
    const result = await db.transaction((tx) =>
      readEntities(tx, { stackId, domain: null, type: "tool", minConfidence: 0, limit: 50 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entity) => entity.name)).toEqual(["Beta"]);
  }, 30_000);

  it.skipIf(!reachable)("finds one entity by case-insensitive name", async () => {
    const result = await db.transaction((tx) =>
      readEntityByName(tx, stackId, null, "alpha"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `lower(name) = lower(?)`, so a lowercased query finds the capitalized row.
    expect(result.value.name).toBe("Alpha");
  }, 30_000);

  it.skipIf(!reachable)("reports not_found as a coded failure rather than throwing", async () => {
    const result = await db.transaction((tx) =>
      readEntityByName(tx, stackId, null, "Nonexistent"),
    );
    // A missing entity is an EXPECTED answer carrying a code; a transport maps
    // that code onto 404, so the assertion is shared with the reader suites.
    expectNotFoundCode(result);
  }, 30_000);

  it.skipIf(!reachable)("walks relationships from an anchor and counts distinct entities", async () => {
    const result = await db.transaction((tx) =>
      traverseGraph(tx, { start: "Alpha", stackId, domain: null, maxDepth: 2, relationshipTypes: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.start).toBe("Alpha");
    expect(result.value.steps.length).toBeGreaterThan(0);
    // Anchor plus both endpoints of the edge.
    expect(result.value.entityCount).toBe(2);
  }, 30_000);

  it.skipIf(!reachable)("honours the relationship_types filter, the case a fidelity test caught", async () => {
    const matching = await db.transaction((tx) =>
      traverseGraph(tx, { start: "Alpha", stackId, domain: null, maxDepth: 2, relationshipTypes: "uses" }),
    );
    const nonMatching = await db.transaction((tx) =>
      traverseGraph(tx, { start: "Alpha", stackId, domain: null, maxDepth: 2, relationshipTypes: "other" }),
    );
    expect(matching.ok && nonMatching.ok).toBe(true);
    if (!matching.ok || !nonMatching.ok) return;
    // The filter is a Postgres array cast; a broken cast returns the wrong rows.
    expect(matching.value.steps.length).toBeGreaterThan(0);
    expect(nonMatching.value.steps).toHaveLength(0);
  }, 30_000);
});

/**
 * The graph read layer is reached here through a test database, so the resolver that
 * chooses that database is load-bearing for this suite. It is pinned here because it
 * lives in `test/fixtures/**`, which no feature role may write.
 *
 * WHY THE PORT MATTERS MORE THAN IT LOOKS. The vendored production default is 5432.
 * A fixture that propagates an EMPTY override hands that default to production code,
 * which reads `""` as "unset" rather than "no database" and connects to the
 * production port — quietly, against operator data, on a machine where production is
 * reachable. Only the loud variant (ECONNREFUSED) is easy to notice.
 *
 * Pure unit: no Postgres, no environment mutation, no side effects.
 */
describe("the test database resolver never falls back to the production port", () => {
  it("answers with the documented container when no override is set", () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("treats an empty override as ABSENT, the specific bug being closed", () => {
    // `AKS_DATABASE_URL=""` means "use the production port" to production code, so
    // propagating an empty string here would silently retarget the suite.
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_ENV_VAR]: "" })).toBe(
      DEFAULT_TEST_DATABASE_URL,
    );
  });

  it("treats a whitespace-only override as absent too", () => {
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_ENV_VAR]: "   " })).toBe(
      DEFAULT_TEST_DATABASE_URL,
    );
  });

  it("honours an explicit override verbatim", () => {
    const explicit = "postgresql://override:pw@db.internal:6000/other";
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_ENV_VAR]: explicit })).toBe(explicit);
  });

  it("resolves to a non-empty URL on the test container's port, not production's", () => {
    const resolved = testDatabaseUrl({});
    expect(resolved).not.toBe("");
    expect(DEFAULT_TEST_DATABASE_URL).toContain(":5434");
    expect(DEFAULT_TEST_DATABASE_URL).not.toContain(":5432");
    expect(resolved).not.toContain(":5432");
  });
});
