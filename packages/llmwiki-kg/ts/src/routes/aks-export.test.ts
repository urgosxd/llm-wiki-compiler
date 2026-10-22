/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-export.test.ts
 * @description `/aks/v1/export`.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { BUNDLE_KEYS, RELATIONSHIP_KEYS, useDomainPrefix } from "./aks-harness.js";

import { sql } from "drizzle-orm";
import { createFixture, createTestApp, database, deleteFixtureRows, state } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("export");

describe.skipIf(state.skipReason !== false)("aks export (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("exports the whole Stack with the oracle's key set and counts", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}`)
      .expect(200);

    expect(Object.keys(response.body as object)).toEqual([...BUNDLE_KEYS]);
    const bundle = response.body as Record<string, unknown>;

    expect(bundle["aks_version"]).toBe("0.2.0");
    expect(bundle["domain"]).toBe(fixture.domain);
    expect(bundle["stack_id"]).toBe(fixture.stackId);
    expect(bundle["scope"]).toBe("stack");
    expect(bundle["entity_count"]).toBe(3);
    expect(bundle["relationship_count"]).toBe(2);
    expect(bundle["document_count"]).toBe(1);
    expect(bundle["compilation_strategy"]).toBe("incremental");

    // `compiled_at` is request time, serialized the way Pydantic renders a UTC
    // datetime: six fractional digits and a `Z`.
    expect(bundle["compiled_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const documents = bundle["documents"] as Array<Record<string, unknown>>;
    expect(Object.keys(documents[0] ?? {})).toEqual([
      "id",
      "filename",
      "ingested_at",
      "source_hash",
      "truncated",
      "original_length",
      "audit",
    ]);
    expect(documents[0]?.["id"]).toBe(fixture.documentId);

    const relationships = bundle["relationships"] as Array<Record<string, unknown>>;
    for (const relationship of relationships) {
      expect(Object.keys(relationship)).toEqual([...RELATIONSHIP_KEYS]);
    }
  });

  it("filters entities and keeps only edges whose both ends survive", async () => {
    const fixture = await createFixture();

    const confident = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&min_confidence=0.5`)
      .expect(200);

    const body = confident.body as {
      entity_count: number;
      relationship_count: number;
      entities: Array<{ name: string }>;
      relationships: Array<{ type: string }>;
      document_count: number;
    };
    expect(body.entities.map((entity) => entity.name)).toEqual(["Gateway", "Embedding Model"]);
    // `HAS` has `Rate Limit` as its target, which the filter removed, so it is
    // dropped. Both endpoints must survive for an edge to be exported.
    expect(body.relationships.map((relationship) => relationship.type)).toEqual(["USED_BY"]);
    expect(body.entity_count).toBe(2);
    expect(body.relationship_count).toBe(1);
    // Documents are per Stack, not per selected entity, so the count is unchanged.
    expect(body.document_count).toBe(1);
  });

  it("honours verified_only and entity_type", async () => {
    // Base fixture: `Gateway` is verified, the other two are not.
    const fixture = await createFixture();

    const verified = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&verified_only=true`)
      .expect(200);
    const verifiedBody = verified.body as { entities: Array<{ name: string }>; relationship_count: number };
    // Only `Gateway` is verified in the base fixture (`?verified=true` on it).
    expect(verifiedBody.entities.map((entity) => entity.name)).toEqual(["Gateway"]);
    expect(verifiedBody.relationship_count).toBe(0);

    const byType = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&entity_type=CONCEPT`)
      .expect(200);
    const typeBody = byType.body as { entities: Array<{ name: string }>; relationship_count: number };
    expect(typeBody.entities.map((entity) => entity.name)).toEqual(["Rate Limit"]);
    expect(typeBody.relationship_count).toBe(0);

    // An empty entity_type filters nothing (Python truthiness).
    const all = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&entity_type=`)
      .expect(200);
    expect((all.body as { entity_count: number }).entity_count).toBe(3);
  });

  it("exports an empty Stack with empty arrays, not nulls", async () => {
    const fixture = await createFixture({ withDocument: false });
    await database().execute(sql`
      delete from ontology_relationships where stack_id = ${fixture.stackId}
    `);
    await database().execute(sql`
      delete from ontology_entities where stack_id = ${fixture.stackId}
    `);

    const response = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}`)
      .expect(200);

    expect(response.body).toMatchObject({
      entity_count: 0,
      relationship_count: 0,
      document_count: 0,
      documents: [],
      entities: [],
      relationships: [],
    });
  });

  it("validates verified_only and min_confidence before resolving the Stack", async () => {
    const response = await request(app)
      .get("/aks/v1/export?domain=nonexistent&min_confidence=5&verified_only=maybe")
      .expect(422);

    const detail = (response.body as { detail: Array<{ loc: string[] }> }).detail;
    expect(detail.map((entry) => entry.loc)).toEqual([
      ["query", "min_confidence"],
      ["query", "verified_only"],
    ]);
  });

  it("answers 422 when neither stack reference is given", async () => {
    await request(app)
      .get("/aks/v1/export")
      .expect(422)
      .expect({ detail: "Either stack_id (UUID) or domain (slug) must be provided" });
  });
});
