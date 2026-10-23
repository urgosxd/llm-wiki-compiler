/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-entities.test.ts
 * @description `/aks/v1/entities` and `/aks/v1/entities/{name}`.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { ENTITY_KEYS, SOURCE_KEYS, useDomainPrefix } from "./aks-harness.js";

import { sql } from "drizzle-orm";
import { UNKNOWN_UUID, createFixture, createTestApp, database, deleteFixtureRows, fixtureDomainNeverCreated, state } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("entities");

describe.skipIf(state.skipReason !== false)("aks entities (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("lists entities most confident first, with the oracle's key set", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}`)
      .expect(200);

    const entities = response.body as Array<Record<string, unknown>>;
    expect(entities.map((entity) => entity["name"])).toEqual([
      "Gateway",
      "Embedding Model",
      "Rate Limit",
    ]);

    // Key order comes from the DTO, so it is asserted exactly, not as a set.
    for (const entity of entities) {
      expect(Object.keys(entity)).toEqual([...ENTITY_KEYS]);
      expect(Object.keys(entity["source"] as object)).toEqual([...SOURCE_KEYS]);
    }

    // The nested source block is the traceability contract.
    expect(entities[0]?.["source"]).toEqual({
      document_id: null,
      connector_id: null,
      source_kind: "document",
      extracted_at: expect.any(String) as unknown,
      model: "model-a",
      verified: true,
      pipeline: "llamaindex-schema-extraction",
    });
    expect(entities[0]?.["properties"]).toEqual({ tier: "edge" });
    expect(entities[0]?.["contributing_documents"]).toEqual([fixture.documentId]);
    expect(entities[1]?.["contributing_documents"]).toEqual([]);
    expect(entities[1]?.["description"]).toBeNull();
  });

  it("filters by type, honouring an empty value as no filter", async () => {
    const fixture = await createFixture();

    const filtered = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&type=SYSTEM`)
      .expect(200);
    expect((filtered.body as Array<{ name: string }>).map((e) => e.name)).toEqual(["Gateway"]);

    // Python's `if type:` is a truthiness test, so `?type=` filters nothing.
    const empty = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&type=`)
      .expect(200);
    expect((empty.body as unknown[]).length).toBe(3);

    const missingType = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&type=NOPE`)
      .expect(200);
    expect(missingType.body).toEqual([]);
  });

  it("applies min_confidence and limit, and takes the last repeated limit", async () => {
    const fixture = await createFixture();

    const confident = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=0.5`)
      .expect(200);
    expect((confident.body as Array<{ name: string }>).map((e) => e.name)).toEqual([
      "Gateway",
      "Embedding Model",
    ]);

    const one = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&limit=1`)
      .expect(200);
    expect((one.body as unknown[]).length).toBe(1);

    // Measured: `?limit=1&limit=3` behaves like `?limit=3` — Starlette keeps the
    // last occurrence.
    const repeated = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&limit=1&limit=3`)
      .expect(200);
    expect((repeated.body as unknown[]).length).toBe(3);
  });

  it("answers 200 with an empty array for a Stack with no entities", async () => {
    const fixture = await createFixture({ withDocument: false });
    await database().execute(sql`
      delete from ontology_relationships where stack_id = ${fixture.stackId}
    `);
    await database().execute(sql`
      delete from ontology_entities where stack_id = ${fixture.stackId}
    `);

    const response = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}`)
      .expect(200);

    // `[]`, not `null` and not a 404: an existing Stack with no entities is a
    // valid, empty answer.
    expect(response.body).toEqual([]);
  });

  it("resolves the Stack by stack_id as well as by domain", async () => {
    const fixture = await createFixture();

    const byId = await request(app)
      .get(`/aks/v1/entities?stack_id=${fixture.stackId}`)
      .expect(200);
    expect((byId.body as unknown[]).length).toBe(3);

    // Measured: a valid stack_id wins over a nonexistent domain.
    const both = await request(app)
      .get(`/aks/v1/entities?stack_id=${fixture.stackId}&domain=nonexistent`)
      .expect(200);
    expect((both.body as unknown[]).length).toBe(3);
  });

  it("returns a single entity by case-insensitive exact name", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities/cto?domain=${fixture.domain}`)
      .expect(404);
    // Detail echoes the *requested* text, not any row's name.
    expect(response.body).toEqual({ detail: "Entity 'cto' not found in Stack" });

    const found = await request(app)
      .get(`/aks/v1/entities/gateway?domain=${fixture.domain}`)
      .expect(200);

    expect(Object.keys(found.body as object)).toEqual([...ENTITY_KEYS]);
    expect((found.body as { name: string }).name).toBe("Gateway");
    expect((found.body as { contributing_documents: string[] }).contributing_documents).toEqual([
      fixture.documentId,
    ]);
  });

  it("answers 404 when neither stack_id nor domain is resolvable", async () => {
    await request(app).get("/aks/v1/entities?domain=nonexistent").expect(404).expect({
      detail: "Stack 'nonexistent' not found",
    });

    await request(app)
      .get(`/aks/v1/entities?stack_id=${UNKNOWN_UUID}`)
      .expect(404)
      .expect({ detail: `Stack '${UNKNOWN_UUID}' not found` });

    await request(app)
      .get(`/aks/v1/entities?domain=${fixtureDomainNeverCreated()}`)
      .expect(404);
  });

  it("validates the query before resolving the Stack", async () => {
    // FastAPI resolves every parameter before the handler body runs, so a bad
    // `limit` beats a nonexistent domain. Measured on the oracle.
    const response = await request(app)
      .get("/aks/v1/entities?domain=nonexistent&limit=0")
      .expect(422);

    expect(response.body).toEqual({
      detail: [
        {
          type: "greater_than_equal",
          loc: ["query", "limit"],
          msg: "Input should be greater than or equal to 1",
          input: "0",
          ctx: { ge: 1 },
        },
      ],
    });
  });

  it("reports every failing query parameter in declaration order", async () => {
    const response = await request(app)
      .get("/aks/v1/entities?stack_id=nope&min_confidence=2&limit=0")
      .expect(422);

    const detail = (response.body as { detail: Array<{ loc: string[]; type: string }> }).detail;
    expect(detail.map((entry) => entry.loc)).toEqual([
      ["query", "stack_id"],
      ["query", "min_confidence"],
      ["query", "limit"],
    ]);
    expect(detail.map((entry) => entry.type)).toEqual([
      "uuid_parsing",
      "less_than_equal",
      "greater_than_equal",
    ]);
  });

  it("rejects an empty stack_id even when a domain is supplied", async () => {
    // `?stack_id=` is present-but-unparseable, which is a 422 before the
    // resolver ever sees the domain. Measured.
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?stack_id=&domain=${fixture.domain}`)
      .expect(422);

    const detail = (response.body as { detail: Array<{ type: string; loc: string[]; input: string }> })
      .detail;
    expect(detail).toHaveLength(1);
    expect(detail[0]?.type).toBe("uuid_parsing");
    expect(detail[0]?.loc).toEqual(["query", "stack_id"]);
    expect(detail[0]?.input).toBe("");
  });

  it("accepts these valid filter values and rejects those", async () => {
    const fixture = await createFixture();

    // Accepted forms measured on the oracle.
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=1`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=1000`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=0`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=1`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=.5`).expect(200);

    // Rejected forms, each with the oracle's error code.
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=1001`).expect(422);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=abc`).expect(422);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=abc`).expect(422);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=1.5`).expect(422);
  });
});
