/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-context-accepted-only.test.ts
 * @description S3's escape hatch on `POST /aks/v1/context`.
 *
 * The context answer is the one surface an agent quotes as a fact, so the flag has
 * to reach BOTH halves it returns: the entities the selection pass chose and the
 * edges between them. A rejected edge is present by default and dropped when the
 * caller asks for accepted only; a rejected entity is dropped with it.
 *
 * The provider is replaced at TWO seams — retrieval and the chat call — because
 * this is about what a flag does to the answer, not about an embedding or an
 * answer a model gave.
 */

import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

/** The two seam answers, mutable per test. */
const seams = vi.hoisted(() => ({
  entityNames: ["Gateway", "Embedding Model"] as string[],
}));

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
  state,
  useDomainPrefix,
} from "./aks-harness.js";
import type { Fixture } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("contextonly");

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

/** `POST /aks/v1/context` for one fixture, with an optional extra body field. */
function ask(fixture: Fixture, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/aks/v1/context")
    .send({ query: "how are refunds handled?", stackId: fixture.stackId, ...extra });
}

it.skipIf(skip)("returns a rejected edge and a rejected entity when accepted_only is omitted", async () => {
  const fixture = await createFixture();
  await rejectRelationship(fixture.relationshipIds.uses);
  await rejectEntity(fixture.entityIds.model);

  const response = await ask(fixture).expect(200);
  const body = response.body as { entities: { name: string }[]; relationships: { type: string }[] };

  expect(body.entities.map((entity) => entity.name)).toEqual(["Embedding Model", "Gateway"]);
  expect(body.relationships.map((relationship) => relationship.type)).toEqual(["USED_BY"]);
});

it.skipIf(skip)("drops the rejected entity and the rejected edge when accepted_only is true", async () => {
  const fixture = await createFixture();
  await rejectRelationship(fixture.relationshipIds.uses);
  await rejectEntity(fixture.entityIds.model);

  const response = await ask(fixture, { accepted_only: true }).expect(200);
  const body = response.body as {
    entities: { name: string }[];
    relationships: unknown[];
    traversal_path: string[];
  };

  expect(body.entities.map((entity) => entity.name)).toEqual(["Gateway"]);
  expect(body.relationships).toEqual([]);
  expect(body.traversal_path).toEqual(["Gateway"]);
});

it.skipIf(skip)("reads the text \"false\" as false and refuses a value that cannot mean either", async () => {
  const fixture = await createFixture();
  await rejectRelationship(fixture.relationshipIds.uses);

  const spelledOut = await ask(fixture, { accepted_only: "false" }).expect(200);
  expect((spelledOut.body as { relationships: unknown[] }).relationships).toHaveLength(1);

  const refused = await ask(fixture, { accepted_only: "maybe" }).expect(422);
  expect(refused.body).toEqual({
    detail: [
      {
        type: "bool_parsing",
        loc: ["body", "accepted_only"],
        msg: "Input should be a valid boolean, unable to interpret input",
        input: "maybe",
      },
    ],
  });
});
