/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-export-class-marker.test.ts
 * @description S4 on the surfaces that are pure row projections: the bundle export,
 * `GET /aks/v1/entities/{name}`, and the node-link graph.
 *
 * ## The export is the ONE surface whose default is `accepted_only = true`
 *
 * It is the only payload validated against a vendored contract, and that contract closes
 * `AKSRelationship` (`SCHEMA.json:562`, no `properties` map), so a refused edge cannot be
 * marked there. The default therefore returns the accepted class only, which keeps the
 * default bundle byte-identical to what this service emitted before refused rows existed.
 * `accepted_only=false` opts into them, unmarked.
 *
 * The graph is this package's own extension, so its nodes AND edges carry the class —
 * that is where a renderer learns it without a filter.
 */

import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, expect, it } from "vitest";

import {
  createFixture,
  createTestApp,
  database,
  deleteFixtureRows,
  qs,
  RELATIONSHIP_KEYS,
  state,
  useDomainPrefix,
} from "./aks-harness.js";
import type { Fixture } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("exportmark");

/** The database gate every case in this file shares. */
const skip = state.skipReason !== false;

/** The block a refused entity publishes inside `properties`. */
const REFUSED_ENTITY = {
  ontology_classification: {
    verdict: "rejected",
    reason: "UNKNOWN_ENTITY_TYPE",
    offending_type: "WIDGET",
  },
};

let app: Express;

beforeEach(async () => {
  await deleteFixtureRows();
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

/** The refusal body an uninterpretable boolean is answered with. */
function boolParsingDetail(input: string): unknown {
  return {
    detail: [
      {
        type: "bool_parsing",
        loc: ["query", "accepted_only"],
        msg: "Input should be a valid boolean, unable to interpret input",
        input,
      },
    ],
  };
}

/** `GET /aks/v1/export` for one fixture, with the given extra query. */
function readBundle(fixture: Fixture, extra: Record<string, string> = {}) {
  return request(app).get(`/aks/v1/export?${qs({ domain: fixture.domain, ...extra })}`);
}

/** `GET /aks/v1/entities/{name}` for one fixture. */
function findEntity(fixture: Fixture, name: string, extra: Record<string, string> = {}) {
  return request(app).get(
    `/aks/v1/entities/${encodeURIComponent(name)}?${qs({ domain: fixture.domain, ...extra })}`,
  );
}

/** The graph payload of one fixture, with the given extra query. */
async function graphOf(fixture: Fixture, extra: Record<string, string> = {}) {
  const suffix = Object.keys(extra).length === 0 ? "" : `?${qs(extra)}`;
  const response = await request(app)
    .get(`/domain/kg/stacks/${fixture.stackId}/graph${suffix}`)
    .expect(200);
  return response.body as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
}

it.skipIf(skip)("exports only the accepted class by default, with no ontology key anywhere", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);
  await rejectRelationship(fixture.relationshipIds.has);

  const response = await readBundle(fixture).expect(200);

  const body = response.body as {
    entities: { name: string; properties: Record<string, unknown> }[];
    relationships: Record<string, unknown>[];
  };
  expect(body.entities.map((entity) => entity.name)).toEqual(["Embedding Model", "Gateway"]);
  for (const entity of body.entities) {
    expect(entity.properties).not.toHaveProperty("ontology_classification");
  }
  // Nothing on a relationship can be marked here, and nothing pretends to: this is the
  // payload a strict AKS consumer validates, and it must stay inside the contract.
  for (const relationship of body.relationships) {
    expect(relationship).not.toHaveProperty("ontology_classification");
    expect(relationship).not.toHaveProperty("properties");
  }
});

it.skipIf(skip)("drops a refused edge from the default bundle while both its ends stay", async () => {
  const fixture = await createFixture();
  // `uses` runs Gateway -> Embedding Model: both ends are accepted, so the edge's own
  // verdict is the ONLY thing that can remove it from the default bundle. Rejecting
  // `has` instead would prove nothing, its target being refused in the same fixture.
  await rejectRelationship(fixture.relationshipIds.uses);

  const narrowed = await readBundle(fixture).expect(200);
  const narrowedBody = narrowed.body as {
    entity_count: number;
    relationship_count: number;
    relationships: Record<string, unknown>[];
  };
  expect(narrowedBody.entity_count).toBe(3);
  // The accepted edge survives and the refused one is gone: the bundle is narrowed by the
  // edge's own class, not by anything its ends did.
  expect(narrowedBody.relationships.map((edge) => edge["id"])).toEqual([
    fixture.relationshipIds.has,
  ]);
  expect(narrowedBody.relationship_count).toBe(1);

  // The same Stack asked for both classes holds the edge again: the default narrowed it.
  const wide = await readBundle(fixture, { accepted_only: "false" }).expect(200);
  const wideBody = wide.body as {
    relationship_count: number;
    relationships: Record<string, unknown>[];
  };
  expect(wideBody.relationship_count).toBe(2);
  expect(wideBody.relationships.map((edge) => edge["id"])).toContain(
    fixture.relationshipIds.uses,
  );
});

it.skipIf(skip)("gives a refused edge no class key at all when the caller opts in", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);
  await rejectRelationship(fixture.relationshipIds.has);

  const response = await readBundle(fixture, { accepted_only: "false" }).expect(200);
  const body = response.body as {
    entities: { id: string; properties: Record<string, unknown> }[];
    relationships: Record<string, unknown>[];
  };

  // Non-vacuous: the refused edge really reached this payload, so what follows is a
  // statement about a row the serializer actually had to publish.
  const refused = body.relationships.find((edge) => edge["id"] === fixture.relationshipIds.has);
  expect(refused).toBeDefined();
  // `AKSRelationship` is closed, so the ONLY conformant answer is that the key does not
  // exist: `properties: null` would add a key the contract forbids. The exact key set
  // says absent, where a presence check alone cannot.
  expect(Object.keys(refused ?? {}).sort()).toEqual([...RELATIONSHIP_KEYS].sort());
  expect(refused ?? {}).not.toHaveProperty("properties");
  expect(refused ?? {}).not.toHaveProperty("ontology_classification");
  expect(Object.values(refused ?? {}).every((value) => value !== null)).toBe(true);

  // The refused ENTITY does publish its class, inside `properties`, so there the key set is
  // exact the other way: the block itself, never a null standing in for it.
  const limit = body.entities.find((entity) => entity.id === fixture.entityIds.limit);
  expect(Object.keys(limit?.properties ?? {}).sort()).toEqual(["ontology_classification"]);
  expect(Object.values(limit?.properties ?? {}).every((value) => value !== null)).toBe(true);
});

it.skipIf(skip)("returns the refused entity marked inside properties when the caller opts in", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);

  const response = await readBundle(fixture, { accepted_only: "false" }).expect(200);

  const entities = (response.body as { entities: Record<string, unknown>[] }).entities;
  const limit = entities.find((entity) => entity["id"] === fixture.entityIds.limit);
  expect(limit?.["properties"]).toEqual(REFUSED_ENTITY);
  const gateway = entities.find((entity) => entity["id"] === fixture.entityIds.gateway);
  expect(gateway?.["properties"]).toEqual({ tier: "edge" });
  expect(gateway).not.toHaveProperty("ontology_classification");
});

it.skipIf(skip)("refuses an ambiguous export filter instead of coercing it", async () => {
  const fixture = await createFixture();

  const response = await readBundle(fixture, { accepted_only: "maybe" }).expect(422);

  expect(response.body).toEqual(boolParsingDetail("maybe"));
});

it.skipIf(skip)("marks a refused entity on the single-entity route", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);

  const accepted = await findEntity(fixture, "Gateway").expect(200);
  const refused = await findEntity(fixture, "Rate Limit").expect(200);

  expect((accepted.body as Record<string, unknown>)["properties"]).toEqual({ tier: "edge" });
  expect((refused.body as Record<string, unknown>)["properties"]).toEqual(REFUSED_ENTITY);
  expect(refused.body).not.toHaveProperty("ontology_classification");
});

it.skipIf(skip)("answers a refused entity with the existing not-found response, not a new status", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);

  const response = await findEntity(fixture, "Rate Limit", { accepted_only: "true" }).expect(404);

  expect(response.body).toEqual({ detail: "Entity 'Rate Limit' not found in Stack" });
});

it.skipIf(skip)("still answers an accepted entity when accepted_only is true", async () => {
  const fixture = await createFixture();

  const response = await findEntity(fixture, "Gateway", { accepted_only: "true" }).expect(200);

  expect((response.body as Record<string, unknown>)["name"]).toBe("Gateway");
});

it.skipIf(skip)("refuses an ambiguous filter on the single-entity route", async () => {
  const fixture = await createFixture();

  const response = await findEntity(fixture, "Gateway", { accepted_only: "sure" }).expect(422);

  expect(response.body).toEqual(boolParsingDetail("sure"));
});

it.skipIf(skip)("gives every node and every edge a class on the graph projection", async () => {
  const fixture = await createFixture();

  const body = await graphOf(fixture);

  for (const node of body.nodes) {
    expect(node["ontology_classification"]).toEqual({
      verdict: "accepted",
      reason: null,
      offending_type: null,
    });
  }
  for (const edge of body.edges) {
    expect(edge["ontology_classification"]).toEqual({
      verdict: "accepted",
      reason: null,
      offending_type: null,
    });
  }
});

it.skipIf(skip)("says which node and which edge the ontology refused, and why", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);
  await rejectRelationship(fixture.relationshipIds.has);

  const body = await graphOf(fixture);

  const limit = body.nodes.find((node) => node["id"] === fixture.entityIds.limit);
  expect(limit?.["ontology_classification"]).toEqual({
    verdict: "rejected",
    reason: "UNKNOWN_ENTITY_TYPE",
    offending_type: "WIDGET",
  });
  const has = body.edges.find((edge) => edge["id"] === fixture.relationshipIds.has);
  expect(has?.["ontology_classification"]).toEqual({
    verdict: "rejected",
    reason: "UNKNOWN_RELATIONSHIP_TYPE",
    offending_type: "ABSORBS",
  });
  const uses = body.edges.find((edge) => edge["id"] === fixture.relationshipIds.uses);
  expect(uses?.["ontology_classification"]).toEqual({
    verdict: "accepted",
    reason: null,
    offending_type: null,
  });
});
