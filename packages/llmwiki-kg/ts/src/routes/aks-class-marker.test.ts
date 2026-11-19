/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-class-marker.test.ts
 * @description S4 on the two answer surfaces an agent reads through MCP:
 * `POST /aks/v1/context` (which `query_stack` reads) and `GET /aks/v1/traverse`
 * (which `traverse_stack` reads).
 *
 * ## The asymmetry this file pins
 *
 * AKS 0.1.0 closes `AKSRelationship` (`SCHEMA.json:562`, `additionalProperties: false`)
 * and gives it no `properties` map, so a refused EDGE has no lawful channel on this
 * JSON: it comes back unmarked, and `accepted_only` is the only way to exclude it. An
 * ENTITY does have a channel — `SCHEMA.json:520` leaves `properties` open — so a
 * refused entity states its class, its reason and its offending type there.
 *
 * Both halves are asserted by VALUE, and the accepted cases are asserted empty, so the
 * gap cannot widen silently and the accepted payload cannot quietly gain a key.
 */

import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

/** The two seam answers, mutable per test. */
const seams = vi.hoisted(() => ({ entityNames: ["Gateway", "Embedding Model"] as string[] }));

vi.mock("../core/retrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/retrieval.js")>();
  return {
    ...actual,
    retrieveRelevantChunks: async () => [
      {
        id: "00000000-0000-4000-8000-000000000000",
        content: "the gateway routes traffic to the embedding model",
        document_id: "00000000-0000-4000-8000-000000000001",
        chunk_index: 0,
        similarity: 1,
      },
    ],
  };
});

vi.mock("../core/llm_clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm_clients.js")>();
  return {
    ...actual,
    embedQuery: async () => new Array<number>(768).fill(0),
    complete: async () =>
      JSON.stringify({
        entity_names: seams.entityNames,
        reasoning: "both ends of one edge",
        confidence: "HIGH",
      }),
  };
});

import {
  createFixture,
  createTestApp,
  database,
  deleteFixtureRows,
  qs,
  state,
  useDomainPrefix,
} from "./aks-harness.js";
import type { Fixture } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("classmark");

/** The database gate every case in this file shares. */
const skip = state.skipReason !== false;

let app: Express;

beforeEach(async () => {
  await deleteFixtureRows();
  seams.entityNames = ["Gateway", "Embedding Model"];
  app = createTestApp();
});

afterAll(async () => {
  // A suite that never ran must not ask for the database it never had.
  if (skip) return;
  await deleteFixtureRows();
});

/** Marks one entity ontology-rejected, with the reason the classifier records. */
async function rejectEntity(id: string): Promise<void> {
  await database().execute(sql`
    update ontology_entities
    set ontology_verdict = 'rejected',
        ontology_rejection_reason = 'UNKNOWN_ENTITY_TYPE',
        ontology_offending_type = 'WIDGET'
    where id = ${id}
  `);
}

/** Marks one relationship ontology-rejected, with its own reason. */
async function rejectRelationship(id: string): Promise<void> {
  await database().execute(sql`
    update ontology_relationships
    set ontology_verdict = 'rejected',
        ontology_rejection_reason = 'UNKNOWN_RELATIONSHIP_TYPE',
        ontology_offending_type = 'ABSORBS'
    where id = ${id}
  `);
}

/** `POST /aks/v1/context` for one fixture, with an optional extra body field. */
function ask(fixture: Fixture, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/aks/v1/context")
    .send({ query: "how are refunds handled?", stackId: fixture.stackId, ...extra });
}

/** `GET /aks/v1/traverse` from the fixture's Gateway. */
function walk(fixture: Fixture, extra: Record<string, string> = {}) {
  return request(app).get(
    `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, ...extra })}`,
  );
}

/** One entity of a context answer, by name. */
function contextEntity(body: unknown, name: string): Record<string, unknown> | undefined {
  const entities = (body as { entities: Record<string, unknown>[] }).entities;
  return entities.find((entity) => entity["name"] === name);
}

it.skipIf(skip)("marks a refused entity inside its properties, with reason and offending type", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.model);

  const response = await ask(fixture).expect(200);

  expect(contextEntity(response.body, "Embedding Model")?.["properties"]).toEqual({
    ontology_classification: {
      verdict: "rejected",
      reason: "UNKNOWN_ENTITY_TYPE",
      offending_type: "WIDGET",
    },
  });
});

it.skipIf(skip)("adds nothing to an accepted entity's properties", async () => {
  const fixture = await createFixture();

  const response = await ask(fixture).expect(200);

  // The read path's own doctrine: a row with nothing to report publishes nothing, so an
  // accepted entity's payload is byte-identical to the one this service emitted before
  // the feature existed.
  expect(contextEntity(response.body, "Gateway")?.["properties"]).toEqual({ tier: "edge" });
  expect(contextEntity(response.body, "Embedding Model")?.["properties"]).toEqual({});
});

it.skipIf(skip)("returns a refused EDGE unmarked, and hides it behind accepted_only", async () => {
  const fixture = await createFixture();
  await rejectRelationship(fixture.relationshipIds.uses);

  const wide = await ask(fixture).expect(200);
  const narrow = await ask(fixture, { accepted_only: true }).expect(200);

  const relationships = (wide.body as { relationships: Record<string, unknown>[] }).relationships;
  // The pinned gap, asserted rather than reported: AKS closes the relationship object, so
  // there is NO classification key anywhere on it — not at the top level, not in a
  // `properties` map it does not have.
  expect(relationships[0]?.["ontology_classification"]).toBeUndefined();
  expect(relationships[0]?.["properties"]).toBeUndefined();
  expect((narrow.body as { relationships: unknown[] }).relationships).toEqual([]);
});

it.skipIf(skip)("marks an accepted traversal step as accepted", async () => {
  const fixture = await createFixture();

  const response = await walk(fixture).expect(200);

  const steps = (response.body as { steps: Record<string, unknown>[] }).steps;
  expect(steps[0]?.["ontology_classification"]).toEqual({
    verdict: "accepted",
    reason: null,
    offending_type: null,
  });
});

it.skipIf(skip)("marks the traversal step that crossed a refused edge", async () => {
  const fixture = await createFixture();
  await rejectRelationship(fixture.relationshipIds.has);

  const response = await walk(fixture).expect(200);

  const steps = (response.body as { steps: Record<string, unknown>[] }).steps;
  expect(steps[1]?.["relationship"]).toBe("HAS");
  expect(steps[1]?.["ontology_classification"]).toEqual({
    verdict: "rejected",
    reason: "UNKNOWN_RELATIONSHIP_TYPE",
    offending_type: "ABSORBS",
  });
});
