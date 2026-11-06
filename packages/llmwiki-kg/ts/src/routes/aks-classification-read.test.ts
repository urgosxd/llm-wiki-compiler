/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-classification-read.test.ts
 * @description The AKS read path over a graph that holds classified and free items.
 *
 * Scenario S45.15: general queries and traversals reach both kinds, a filter by
 * canonical type reaches only classified items, and a caller can ask for the free
 * ones together with the reason they are free.
 *
 * Every assertion goes through HTTP, never through the storage the handler writes.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
useDomainPrefix("kgread");

/** One entity row this suite seeds directly, with its classification columns. */
interface SeededEntity {
  readonly name: string;
  readonly type: string;
  readonly confidence: number;
  readonly state: string | null;
  readonly canonical: string | null;
  readonly support?: string | null;
  readonly identityKey?: string;
}

/** One relationship row this suite seeds directly. */
interface SeededEdge {
  readonly type: string;
  readonly state: string | null;
  readonly canonical: string | null;
}

/** A row a catalog classification confirmed. */
function classified(name: string, type: string, confidence = 0.8): SeededEntity {
  return { name, type, confidence, state: "classified", canonical: type };
}

/** A row that was decided against the catalog: no canonical type fitted. */
function free(name: string, type: string, confidence = 0.9): SeededEntity {
  return { name, type, confidence, state: "free_no_match", canonical: null };
}

/** Inserts one entity whose classification columns are stated, never inferred. */
async function seedEntity(stackId: string, entity: SeededEntity): Promise<string> {
  const id = randomUUID();
  await database().execute(sql`
    insert into ontology_entities (
      id, stack_id, name, type, confidence, identity_key,
      proposed_type, classification_state, canonical_type, support_state
    )
    values (
      ${id}, ${stackId}, ${entity.name}, ${entity.type}, ${entity.confidence},
      ${entity.identityKey ?? null}, ${entity.type}, ${entity.state},
      ${entity.canonical}, ${entity.support ?? null}
    )
  `);
  return id;
}

/** Seeds one entity plus one edge from the fixture's Gateway to it. */
async function seedNeighbour(
  fixture: Fixture,
  entity: SeededEntity,
  edge: SeededEdge,
): Promise<string> {
  const id = await seedEntity(fixture.stackId, entity);
  await database().execute(sql`
    insert into ontology_relationships (
      id, stack_id, from_entity_id, to_entity_id, type, confidence,
      classification_state, canonical_type
    )
    values (
      ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway}, ${id},
      ${edge.type}, ${0.8}, ${edge.state}, ${edge.canonical}
    )
  `);
  return id;
}

/** The `name` of every entity the endpoint returned, in response order. */
function names(body: unknown): string[] {
  return (body as { name: string }[]).map((entity) => entity.name);
}

/** One entity of a list response, by position. */
function entityAt(body: unknown, index: number): Record<string, unknown> {
  return (body as Record<string, unknown>[])[index] ?? {};
}

/** The `kg_classification` block one entity publishes, list response or not. */
function blockOf(body: unknown, index = 0): Record<string, unknown> {
  const properties = entityAt(body, index)["properties"];
  return (properties as Record<string, Record<string, unknown>>)["kg_classification"] ?? {};
}

/** The walk's steps, as the response reports them. */
function stepsOf(body: unknown): { relationship: string; to_entity: string }[] {
  return (body as { steps: { relationship: string; to_entity: string }[] }).steps;
}

describe.skipIf(state.skipReason !== false)("aks read path over classified and free items", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("returns classified, free and pending entities from a general query", async () => {
    const fixture = await createFixture();
    await seedEntity(fixture.stackId, { ...free("Care Coordinator", "ROLE", 0.5), support: "supported" });
    await database().execute(sql`
      update ontology_entities
      set classification_state = 'classified', canonical_type = 'SYSTEM'
      where id = ${fixture.entityIds.gateway}
    `);

    const response = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain })}`)
      .expect(200);

    // No classification predicate when nobody asked for one: classified, free and
    // undecided rows all come back.
    expect(names(response.body)).toEqual([
      "Gateway",
      "Embedding Model",
      "Care Coordinator",
      "Rate Limit",
    ]);
  });

  it("publishes each entity's state and reason inside its properties", async () => {
    const fixture = await createFixture();
    await seedEntity(fixture.stackId, { ...free("Care Coordinator", "ROLE", 0.5), support: "supported" });
    await database().execute(sql`
      update ontology_entities
      set classification_state = 'classified', canonical_type = 'SYSTEM'
      where id = ${fixture.entityIds.gateway}
    `);

    const response = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain })}`)
      .expect(200);

    expect(blockOf(response.body, 0)).toEqual({
      state: "classified",
      classified: true,
      is_free: false,
      reason: null,
      canonical_type: "SYSTEM",
      proposed_type: "SYSTEM",
      support_state: null,
    });
    expect(blockOf(response.body, 2)).toEqual({
      state: "free_no_match",
      classified: false,
      is_free: true,
      reason: "no_canonical_type_matched",
      canonical_type: null,
      proposed_type: "ROLE",
      support_state: "supported",
    });
    // A row with no recorded decision exposes nothing: there is nothing to report.
    expect(entityAt(response.body, 1)["properties"]).toEqual({});
  });

  it("filters by canonical type, returning only classified matches", async () => {
    const fixture = await createFixture();
    await seedEntity(fixture.stackId, free("Care Coordinator", "ROLE"));
    const classifiedRole = await seedEntity(fixture.stackId, classified("Shift Lead", "ROLE"));
    // The projection label differs from the canonical one on purpose: the filter
    // must read the catalog decision, not the display label.
    await seedEntity(fixture.stackId, {
      name: "Ramp Up",
      type: "PROCESO",
      confidence: 0.7,
      state: "classified",
      canonical: "PROCESS",
    });

    const roles = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, type: "ROLE" })}`)
      .expect(200);
    expect(names(roles.body)).toEqual(["Shift Lead"]);
    expect(entityAt(roles.body, 0)["id"]).toBe(classifiedRole);

    const processes = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, type: "PROCESS" })}`)
      .expect(200);
    expect(names(processes.body)).toEqual(["Ramp Up"]);
  });

  it("matches a row with no recorded decision through its label, as before", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, type: "SYSTEM" })}`)
      .expect(200);

    // Human-reviewed and pre-classification rows carry no decision at all; the
    // endpoint's existing contract already returned them, and it still does.
    expect(names(response.body)).toEqual(["Gateway"]);
  });

  it("answers the free-items query with the state and the reason per entity", async () => {
    const fixture = await createFixture();
    await seedEntity(fixture.stackId, free("Care Coordinator", "ROLE"));
    await seedEntity(fixture.stackId, {
      name: "Unclear Thing",
      type: "CONCEPT",
      confidence: 0.8,
      state: "free_uncertain",
      canonical: null,
    });

    const freeItems = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, classification_state: "free" })}`)
      .expect(200);

    // `free` is both free states and nothing else.
    expect(names(freeItems.body)).toEqual(["Care Coordinator", "Unclear Thing"]);
    expect([blockOf(freeItems.body, 0), blockOf(freeItems.body, 1)]).toEqual([
      expect.objectContaining({ is_free: true, reason: "no_canonical_type_matched" }),
      expect.objectContaining({ is_free: true, reason: "classification_uncertain" }),
    ]);
  });

  it("separates a pending or failed item from a free one", async () => {
    const fixture = await createFixture();
    await seedEntity(fixture.stackId, {
      name: "Awaiting Classifier",
      type: "CONCEPT",
      confidence: 0.7,
      state: "pending",
      canonical: null,
    });
    await seedEntity(fixture.stackId, {
      name: "Classifier Outage",
      type: "CONCEPT",
      confidence: 0.6,
      state: "failed",
      canonical: null,
    });

    const pending = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, classification_state: "pending" })}`)
      .expect(200);
    // A pending item is not "free": it waits for a decision, it was not decided
    // against the catalog (S3, S26).
    expect(names(pending.body)).toEqual(["Awaiting Classifier"]);
    expect(blockOf(pending.body, 0)).toEqual({
      state: "pending",
      classified: false,
      is_free: false,
      reason: "classification_pending",
      canonical_type: null,
      proposed_type: "CONCEPT",
      support_state: null,
    });

    const failed = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, classification_state: "failed" })}`)
      .expect(200);
    expect(names(failed.body)).toEqual(["Classifier Outage"]);
    expect(blockOf(failed.body, 0)["reason"]).toBe("classification_failed");
  });

  it("rejects an unknown classification state naming the accepted values", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, classification_state: "libre" })}`)
      .expect(422);

    expect(response.body).toEqual({
      detail: [
        {
          type: "literal_error",
          loc: ["query", "classification_state"],
          msg:
            "Input should be 'classified', 'free', 'free_no_match', 'free_uncertain', " +
            "'pending' or 'failed'",
          input: "libre",
          ctx: {
            expected:
              "'classified', 'free', 'free_no_match', 'free_uncertain', 'pending' or 'failed'",
          },
        },
      ],
    });
  });

  it("refuses an empty state value, which is present but not a state", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain })}&classification_state=`)
      .expect(422);

    const detail = (response.body as { detail: { type: string; input: string }[] }).detail;
    // Unlike `?type=`, whose empty value always meant "no filter", this parameter is
    // a closed set: an empty string is a value nobody accepts.
    expect(detail.map((entry) => [entry.type, entry.input])).toEqual([["literal_error", ""]]);
  });

  it("walks past a free entity and across a free relationship", async () => {
    const fixture = await createFixture();
    await seedNeighbour(fixture, free("Care Coordinator", "ROLE"), {
      type: "DEJA_SIN_EFECTO",
      state: "free_no_match",
      canonical: null,
    });

    const response = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "2" })}`)
      .expect(200);

    expect(stepsOf(response.body).map((step) => [step.relationship, step.to_entity])).toContainEqual([
      "DEJA_SIN_EFECTO",
      "Care Coordinator",
    ]);
    expect((response.body as { entity_count: number }).entity_count).toBe(4);
  });

  it("filters traversal edges by canonical type, keeping free ones out", async () => {
    const fixture = await createFixture();
    // A free edge whose label reads like a canonical relation must not answer the
    // canonical filter; a classified edge whose label reads otherwise must (S41).
    await seedNeighbour(fixture, free("Care Coordinator", "ROLE"), {
      type: "USED_BY",
      state: "free_no_match",
      canonical: null,
    });
    await seedNeighbour(fixture, classified("Ramp Up", "PROCESS"), {
      type: "FEEDS",
      state: "classified",
      canonical: "USED_BY",
    });

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({
          start: "Gateway",
          domain: fixture.domain,
          relationship_types: "USED_BY",
        })}`,
      )
      .expect(200);

    // The fixture's own USED_BY edge carries no recorded decision, so it keeps
    // answering the filter exactly as before; the free one never does.
    expect(
      stepsOf(response.body).map((step) => [step.relationship, step.to_entity]).sort(),
    ).toEqual([
      ["FEEDS", "Ramp Up"],
      ["USED_BY", "Embedding Model"],
    ]);
  });

  it("picks the classified homonym, and reports that the name is shared", async () => {
    const fixture = await createFixture();
    // The free row is inserted first and is more confident, so an unstated order
    // would hand back the free one.
    await seedEntity(fixture.stackId, {
      ...free("Twin Gateway", "SYSTEM", 0.95),
      identityKey: "twin gateway#free",
    });
    const classifiedTwin = await seedEntity(fixture.stackId, {
      ...classified("Twin Gateway", "SYSTEM", 0.4),
      identityKey: "twin gateway#classified",
    });

    const response = await request(app)
      .get(`/aks/v1/entities/twin%20gateway?${qs({ domain: fixture.domain })}`)
      .expect(200);

    expect((response.body as { id: string }).id).toBe(classifiedTwin);
    expect(blockOf([response.body])).toEqual({
      state: "classified",
      classified: true,
      is_free: false,
      reason: null,
      canonical_type: "SYSTEM",
      proposed_type: "SYSTEM",
      support_state: null,
      name_matches: 2,
    });
  });

  it("never turns a free relationship into canonical-relation behaviour", async () => {
    const fixture = await createFixture();
    const planner = await seedEntity(fixture.stackId, classified("Planner", "ROLE"));
    const review = await seedEntity(fixture.stackId, classified("Review", "PROCESS"));
    // A hierarchy-shaped free predicate: no inference engine may read it as one.
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence,
        classification_state, canonical_type
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${planner}, ${review},
        ${"SUBTYPE_OF"}, ${0.8}, ${"free_no_match"}, ${null}
      )
    `);

    const roles = await request(app)
      .get(`/aks/v1/entities?${qs({ domain: fixture.domain, type: "ROLE" })}`)
      .expect(200);

    // Only the endpoint whose own decision says ROLE; the free edge promotes nobody.
    expect(names(roles.body)).toEqual(["Planner"]);
    // No read either derives a canonical type from an edge or writes one back.
    const rows = await database().execute<{ name: string; canonical_type: string | null }>(sql`
      select name, canonical_type from ontology_entities
      where id in (${planner}, ${review}) order by name
    `);
    expect(rows.map((row) => [row.name, row.canonical_type])).toEqual([
      ["Planner", "ROLE"],
      ["Review", "PROCESS"],
    ]);
  });
});
