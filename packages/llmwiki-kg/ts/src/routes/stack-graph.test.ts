/**
 * @file packages/llmwiki-kg/ts/src/routes/stack-graph.test.ts
 * @description `GET /stacks/{stack_id}/graph` — the render payload.
 *
 * The suite asserts the wire contract a renderer consumes: envelope key order,
 * the entity→node and relationship→edge projections, and the three ways a
 * request can end without a graph (404, 422 on the path axis, 422 on the query
 * axis). Truncation is asserted separately because it is the one behaviour that
 * changes the graph rather than the envelope.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { sql } from "drizzle-orm";

import {
  UNKNOWN_UUID,
  createFixture,
  createTestApp,
  database,
  deleteFixtureRows,
  qs,
  state,
  useDomainPrefix,
} from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("stackgraph");

/** Envelope keys, in the order the response schema declares them. */
const GRAPH_KEYS = ["stack_id", "node_count", "edge_count", "truncated", "nodes", "edges"] as const;

/** Node keys, in declaration order. */
const NODE_KEYS = ["id", "label", "type", "confidence", "verified", "properties"] as const;

/** Edge keys, in declaration order. */
const EDGE_KEYS = ["id", "source", "target", "type", "confidence", "verified"] as const;

interface GraphBody {
  stack_id: string;
  node_count: number;
  edge_count: number;
  truncated: boolean;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

/**
 * Domains created through `POST /stacks` rather than `createFixture`.
 *
 * `deleteFixtureRows` deletes by the `aks-harness` domain prefix, which a Stack
 * created through the API does not carry, so this suite removes its own.
 */
const createdDomains: string[] = [];

/**
 * A unique domain for a Stack created through the API.
 *
 * The prefix keeps it inside this file's fixtures namespace, and it is recorded
 * in {@link createdDomains} so `afterAll` can delete it — the shared cleanup
 * would never find it.
 */
function emptyStackDomain(): string {
  const domain = `stackgraph-empty-${Date.now().toString(36)}`;
  createdDomains.push(domain);
  return domain;
}

describe.skipIf(state.skipReason !== false)("stack graph (live database)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
    for (const domain of createdDomains.splice(0)) {
      await database().execute(sql`delete from stacks where domain = ${domain}`);
    }
  });

  /** Fetches the graph, asserting the 200 every case below expects. */
  async function getGraph(
    stackId: string,
    query: Record<string, string> = {},
  ): Promise<GraphBody> {
    const suffix = Object.keys(query).length === 0 ? "" : `?${qs(query)}`;
    const response = await request(app)
      .get(`/stacks/${stackId}/graph${suffix}`)
      .expect(200);
    return response.body as GraphBody;
  }

  it("answers the documented envelope and key order", async () => {
    const fixture = await createFixture();
    const body = await getGraph(fixture.stackId);

    expect(Object.keys(body)).toEqual([...GRAPH_KEYS]);
    expect(body.stack_id).toBe(fixture.stackId);
    expect(body.node_count).toBe(3);
    expect(body.edge_count).toBe(2);
    expect(body.truncated).toBe(false);
    expect(Object.keys(body.nodes[0] as object)).toEqual([...NODE_KEYS]);
    expect(Object.keys(body.edges[0] as object)).toEqual([...EDGE_KEYS]);
  });

  it("projects an entity onto a node without losing its render-bearing fields", async () => {
    const fixture = await createFixture();
    const body = await getGraph(fixture.stackId);

    expect(body.nodes[0]).toEqual({
      id: fixture.entityIds.gateway,
      label: "Gateway",
      type: "SYSTEM",
      confidence: 0.9,
      verified: true,
      properties: { tier: "edge" },
    });
  });

  it("projects a relationship onto an edge keyed by its two entity ids", async () => {
    const fixture = await createFixture();
    const body = await getGraph(fixture.stackId);

    expect(body.edges[0]).toEqual({
      id: fixture.relationshipIds.uses,
      source: fixture.entityIds.gateway,
      target: fixture.entityIds.model,
      type: "USED_BY",
      confidence: 0.75,
      verified: false,
    });
  });

  it("answers an unconfigured Stack as empty arrays rather than nulls", async () => {
    const created = await request(app)
      .post("/stacks")
      .send({ name: "Empty Stack", domain: emptyStackDomain() })
      .expect(201);

    const body = await getGraph(String(created.body.id));
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.node_count).toBe(0);
    expect(body.edge_count).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it("answers 404 with the canonical UUID for an unknown Stack", async () => {
    const response = await request(app)
      .get(`/stacks/${UNKNOWN_UUID}/graph`)
      .expect(404);
    expect(response.body).toEqual({ detail: `Stack '${UNKNOWN_UUID}' not found` });
  });

  it("answers 422 on the path axis for a malformed Stack id", async () => {
    const response = await request(app).get("/stacks/not-a-uuid/graph").expect(422);
    const detail = (response.body as { detail: Array<Record<string, unknown>> }).detail;
    expect(detail[0]?.["loc"]).toEqual(["path", "stack_id"]);
    expect(detail[0]?.["input"]).toBe("not-a-uuid");
  });

  it("truncates to `limit` and drops edges whose endpoint was cut", async () => {
    const fixture = await createFixture();
    const body = await getGraph(fixture.stackId, { limit: "2" });

    expect(body.truncated).toBe(true);
    expect(body.node_count).toBe(2);
    // The surviving endpoints are Gateway and Embedding Model; the second edge
    // points at the truncated Rate Limit node, so it cannot be drawn.
    expect(body.edges).toHaveLength(1);
    expect(body.edge_count).toBe(1);
    expect(body.edges[0]?.["id"]).toBe(fixture.relationshipIds.uses);
  });

  it("filters by min_confidence without reporting truncation", async () => {
    const fixture = await createFixture();
    const body = await getGraph(fixture.stackId, { min_confidence: "0.5" });

    expect(body.truncated).toBe(false);
    expect(body.node_count).toBe(2);
    expect(body.nodes.map((node) => node["label"])).toEqual(["Gateway", "Embedding Model"]);
    expect(body.edges).toHaveLength(1);
  });

  it("keeps the last occurrence of a repeated parameter", async () => {
    const fixture = await createFixture();
    // Starlette hands the LAST occurrence to the parameter, and the shared
    // `readQuery` helper reproduces that. Two readers disagreeing here would be
    // invisible until a caller sent a repeated key.
    const body = await getGraph(fixture.stackId, { limit: "1" });
    const repeated = await request(app)
      .get(`/stacks/${fixture.stackId}/graph?limit=1&limit=3`)
      .expect(200);

    expect((body as GraphBody).node_count).toBe(1);
    expect((repeated.body as GraphBody).node_count).toBe(3);
  });

  it("refuses a limit outside the inclusive bounds", async () => {
    const fixture = await createFixture();
    for (const limit of ["0", "2001", "abc"]) {
      const response = await request(app)
        .get(`/stacks/${fixture.stackId}/graph?${qs({ limit })}`)
        .expect(422);
      const detail = (response.body as { detail: Array<Record<string, unknown>> }).detail;
      expect(detail[0]?.["loc"]).toEqual(["query", "limit"]);
    }
  });
});
