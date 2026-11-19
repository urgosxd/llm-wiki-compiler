/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-accepted-only.test.ts
 * @description S3's escape hatch on the HTTP graph surfaces.
 *
 * The default returns BOTH ontology classes; `accepted_only=true` narrows to the
 * accepted ones. Polarity is exclusion-ON, so a caller who does nothing still gets
 * the wide graph and only a caller who asks loses rows.
 *
 * Each surface is asserted in three states, because two are not enough to pin a
 * boolean: omitted (both classes), `true` (accepted only) and an ambiguous value
 * (`?accepted_only=maybe`), which is REFUSED rather than coerced. The `"false"`
 * string is asserted too — it is text, and text must never be read as true.
 *
 * The traversal case walks TWO hops, the second of which exists only across a
 * rejected edge: a listing-only assertion would not prove the flag changes the
 * neighbour set rather than just the projected rows.
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
  state,
  useDomainPrefix,
} from "./aks-harness.js";
import type { Fixture } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("acceptedonly");

/** The database gate every case in this file shares. */
const skip = state.skipReason !== false;

/** The graph endpoint under test. */
const GRAPH_BASE = "/domain/kg/stacks";

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

/** The `name` of every entity in a list response, in response order. */
function names(body: unknown): string[] {
  return (body as { name: string }[]).map((entity) => entity.name);
}

/** One walk's steps, as `[relationship, to_entity]` pairs. */
function stepPairs(body: unknown): [string, string][] {
  const steps = (body as { steps: { relationship: string; to_entity: string }[] }).steps;
  return steps.map((step) => [step.relationship, step.to_entity]);
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

/** `GET /aks/v1/entities` for one fixture, with the given extra query. */
function listEntities(fixture: Fixture, extra: Record<string, string> = {}) {
  return request(app).get(`/aks/v1/entities?${qs({ domain: fixture.domain, ...extra })}`);
}

/** `GET /aks/v1/traverse` for one fixture from its Gateway, with extra query. */
function walk(fixture: Fixture, extra: Record<string, string> = {}) {
  return request(app).get(
    `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, ...extra })}`,
  );
}

/** `GET /domain/kg/stacks/{id}/graph` for one fixture, with extra query. */
function graphOf(fixture: Fixture, extra: Record<string, string> = {}) {
  return request(app).get(`${GRAPH_BASE}/${fixture.stackId}/graph?${qs(extra)}`);
}

it.skipIf(skip)("returns a rejected and an accepted entity when accepted_only is omitted", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);

  const response = await listEntities(fixture).expect(200);

  expect(names(response.body)).toEqual(["Gateway", "Embedding Model", "Rate Limit"]);
});

it.skipIf(skip)("omits the rejected entity when accepted_only is true", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);

  const accepted = await listEntities(fixture, { accepted_only: "true" }).expect(200);
  const spelledOut = await listEntities(fixture, { accepted_only: "false" }).expect(200);

  expect(names(accepted.body)).toEqual(["Gateway", "Embedding Model"]);
  // `"false"` is text: it is read as false, never coerced to true.
  expect(names(spelledOut.body)).toContain("Rate Limit");
});

it.skipIf(skip)("refuses an ambiguous entity filter instead of coercing it", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);

  const response = await listEntities(fixture, { accepted_only: "maybe" }).expect(422);

  // No rows travel beside the refusal: the answer is the error and nothing else.
  expect(response.body).toEqual(boolParsingDetail("maybe"));
});

it.skipIf(skip)("walks across a rejected edge by default, and cannot with accepted_only", async () => {
  const fixture = await createFixture();
  // Gateway -> Embedding Model is accepted; Embedding Model -> Rate Limit is not.
  // The second hop therefore exists ONLY through a rejected edge.
  await rejectRelationship(fixture.relationshipIds.has);

  const wide = await walk(fixture).expect(200);
  const narrow = await walk(fixture, { accepted_only: "true" }).expect(200);

  expect(stepPairs(wide.body)).toEqual([
    ["USED_BY", "Embedding Model"],
    ["HAS", "Rate Limit"],
  ]);
  expect((wide.body as { entity_count: number }).entity_count).toBe(3);
  expect(stepPairs(narrow.body)).toEqual([["USED_BY", "Embedding Model"]]);
  expect((narrow.body as { entity_count: number }).entity_count).toBe(2);
});

it.skipIf(skip)("refuses an ambiguous traversal filter", async () => {
  const fixture = await createFixture();

  const response = await walk(fixture, { accepted_only: "1x" }).expect(422);

  expect(response.body).toEqual(boolParsingDetail("1x"));
});

it.skipIf(skip)("returns rejected nodes and edges in the graph by default", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);
  await rejectRelationship(fixture.relationshipIds.has);

  const response = await graphOf(fixture).expect(200);

  const body = response.body as { node_count: number; edge_count: number };
  expect([body.node_count, body.edge_count]).toEqual([3, 2]);
});

it.skipIf(skip)("drops rejected nodes and rejected edges when accepted_only is true", async () => {
  const fixture = await createFixture();
  await rejectEntity(fixture.entityIds.limit);
  await rejectRelationship(fixture.relationshipIds.has);

  const response = await graphOf(fixture, { accepted_only: "true" }).expect(200);

  const body = response.body as {
    node_count: number;
    edge_count: number;
    nodes: { label: string }[];
    edges: { type: string }[];
  };
  // The rejected node is gone AND the rejected edge is gone: the second is not
  // implied by the first, because the surviving endpoints are both accepted.
  expect(body.nodes.map((node) => node.label)).toEqual(["Gateway", "Embedding Model"]);
  expect(body.edges.map((edge) => edge.type)).toEqual(["USED_BY"]);
  expect([body.node_count, body.edge_count]).toEqual([2, 1]);
});

it.skipIf(skip)("refuses an ambiguous graph filter", async () => {
  const fixture = await createFixture();

  const response = await graphOf(fixture, { accepted_only: "yep" }).expect(422);

  expect(response.body).toEqual(boolParsingDetail("yep"));
});
