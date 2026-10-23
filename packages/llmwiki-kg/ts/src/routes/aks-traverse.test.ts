/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-traverse.test.ts
 * @description `/aks/v1/traverse`.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { TRAVERSE_KEYS, TRAVERSE_STEP_KEYS, useDomainPrefix } from "./aks-harness.js";

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createFixture, createTestApp, database, deleteFixtureRows, qs, state } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("traverse");

describe.skipIf(state.skipReason !== false)("aks traverse (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("walks one hop at depth 1 and two hops at depth 2", async () => {
    const fixture = await createFixture();

    const depth1 = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "gateway", domain: fixture.domain, max_depth: "1" })}`)
      .expect(200);

    expect(Object.keys(depth1.body as object)).toEqual([...TRAVERSE_KEYS]);
    const body1 = depth1.body as {
      start: string;
      max_depth: number;
      steps: Array<Record<string, unknown>>;
      entity_count: number;
    };
    expect(body1.start).toBe("Gateway");
    expect(body1.max_depth).toBe(1);
    expect(body1.entity_count).toBe(2);
    expect(body1.steps).toHaveLength(1);
    expect(body1.steps[0]).toMatchObject({
      from_entity: "Gateway",
      relationship: "USED_BY",
      to_entity: "Embedding Model",
      depth: 1,
    });
    expect(body1.steps[0]?.["confidence"]).toBeCloseTo(0.75, 4);

    const depth2 = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "gateway", domain: fixture.domain, max_depth: "2" })}`)
      .expect(200);

    const body2 = depth2.body as { steps: Array<Record<string, unknown>>; entity_count: number };
    expect(body2.steps).toHaveLength(2);
    expect(body2.steps[1]).toMatchObject({
      from_entity: "Embedding Model",
      relationship: "HAS",
      to_entity: "Rate Limit",
      depth: 2,
    });
    expect(body2.steps[1]?.["confidence"]).toBeCloseTo(0.55, 4);
    expect(body2.entity_count).toBe(3);
    for (const step of body2.steps) {
      expect(Object.keys(step)).toEqual([...TRAVERSE_STEP_KEYS]);
    }
  });

  it("defaults max_depth to 2 and honours the relationship_types filter", async () => {
    const fixture = await createFixture();
    const defaults = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain })}`)
      .expect(200);
    expect((defaults.body as { max_depth: number }).max_depth).toBe(2);
    expect((defaults.body as { steps: unknown[] }).steps).toHaveLength(2);

    const onlyUses = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, relationship_types: "USED_BY" })}`)
      .expect(200);
    expect((onlyUses.body as { steps: unknown[] }).steps).toHaveLength(1);
    expect((onlyUses.body as { entity_count: number }).entity_count).toBe(2);

    // An empty filter value follows every edge, because Python tests truthiness.
    const emptyFilter = await request(app)
      .get(
        `/aks/v1/traverse?${qs({
          start: "Gateway",
          domain: fixture.domain,
          relationship_types: "",
        })}`,
      )
      .expect(200);
    expect((emptyFilter.body as { steps: unknown[] }).steps).toHaveLength(2);

    // `","` splits into no usable types, so nothing is followed. Measured.
    const commas = await request(app)
      .get(
        `/aks/v1/traverse?${qs({
          start: "Gateway",
          domain: fixture.domain,
          relationship_types: ",,",
        })}`,
      )
      .expect(200);
    expect(commas.body).toEqual({
      start: "Gateway",
      max_depth: 2,
      steps: [],
      entity_count: 1,
    });
  });

  it("follows edges in one direction only", async () => {
    const fixture = await createFixture();

    // Starting at the chain's tail: `Rate Limit` has no outgoing edge, so the
    // walk finds nothing. A two-way interpretation would walk back up the chain.
    const backwards = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "Rate Limit", domain: fixture.domain })}`)
      .expect(200);

    expect(backwards.body).toEqual({
      start: "Rate Limit",
      max_depth: 2,
      steps: [],
      entity_count: 1,
    });
  });

  it("is cycle-safe: a back-edge does not produce a repeated step", async () => {
    const fixture = await createFixture();
    // Close the loop: Rate Limit -> Gateway.
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.limit},
        ${fixture.entityIds.gateway}, ${"PART_OF"}, ${0.65}
      )
    `);

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "5" })}`,
      )
      .expect(200);

    const body = response.body as { steps: Array<{ to_entity: string }>; entity_count: number };
    // Gateway is already in `visited`, so the back-edge to it is skipped and the
    // walk terminates with exactly the two forward steps.
    expect(body.steps).toHaveLength(2);
    expect(body.entity_count).toBe(3);
  });

  it("returns one step per path through a diamond, but counts entities once", async () => {
    const fixture = await createFixture();
    // Gateway -> Rate Limit directly, so `Rate Limit` is reachable by two paths.
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway},
        ${fixture.entityIds.limit}, ${"HAS"}, ${0.7}
      )
    `);

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "2" })}`,
      )
      .expect(200);

    const body = response.body as { steps: unknown[]; entity_count: number };
    // The visited array travels with each path, so the diamond produces BOTH
    // paths (measured on the oracle: three steps, two of them ending at `Rate
    // Limit`), while `entity_count` counts the distinct set once.
    expect(body.steps).toHaveLength(3);
    expect(body.entity_count).toBe(3);
  });

  it("reports entity_count as a distinct set, not as steps plus one", async () => {
    const fixture = await createFixture();
    // A second child of Gateway, making the walk span four distinct entities in
    // three steps — the case `len(steps) + 1` would over-count.
    const extra = randomUUID();
    await database().execute(sql`
      insert into ontology_entities (id, stack_id, name, type, confidence)
      values (${extra}, ${fixture.stackId}, ${"Cache"}, ${"SYSTEM"}, ${0.8})
    `);
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway},
        ${extra}, ${"USED_BY"}, ${0.7}
      )
    `);

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "2" })}`,
      )
      .expect(200);

    const body = response.body as { steps: unknown[]; entity_count: number };
    expect(body.steps).toHaveLength(3);
    expect(body.entity_count).toBe(4);
  });

  it("answers 404 for an unknown start entity, and 422 for a missing start", async () => {
    const fixture = await createFixture();

    await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "nope", domain: fixture.domain })}`)
      .expect(404)
      .expect({ detail: "Entity 'nope' not found in Stack" });

    // An empty start is a real value, so it is a 404 rather than a 422.
    await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "", domain: fixture.domain })}`)
      .expect(404)
      .expect({ detail: "Entity '' not found in Stack" });

    await request(app)
      .get(`/aks/v1/traverse?domain=${fixture.domain}`)
      .expect(422)
      .expect({
        detail: [
          { type: "missing", loc: ["query", "start"], msg: "Field required", input: null },
        ],
      });
  });

  it("bounds max_depth to 1..5", async () => {
    const fixture = await createFixture();

    for (const depth of ["0", "6", "abc"]) {
      const response = await request(app)
        .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: depth })}`)
        .expect(422);
      expect((response.body as { detail: Array<{ loc: string[] }> }).detail[0]?.loc).toEqual([
        "query",
        "max_depth",
      ]);
    }

    for (const depth of ["1", "5"]) {
      await request(app)
        .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: depth })}`)
        .expect(200);
    }
  });

  it("answers 422 when neither stack reference is given", async () => {
    await request(app)
      .get("/aks/v1/traverse?start=Gateway")
      .expect(422)
      .expect({ detail: "Either stack_id (UUID) or domain (slug) must be provided" });
  });
});
