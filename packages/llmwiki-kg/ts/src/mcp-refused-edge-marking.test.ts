/**
 * @file packages/llmwiki-kg/ts/src/mcp-refused-edge-marking.test.ts
 * @description How `query_stack` still marks a refused edge although AKS cannot carry it.
 *
 * The MCP server formats AKS JSON, and AKS 0.1.0 closes `AKSRelationship`
 * (`SCHEMA.json:562`, `additionalProperties: false`, no `properties` map), so the class
 * of an edge is nowhere in the answer being formatted. The handler resolves it from this
 * package's own graph projection instead — `GET /domain/kg/stacks/:id/graph`, whose edges
 * DO carry the class — and the rendered bullet says which edge was refused.
 *
 * Two behaviours are asserted: the marking itself, and the disclosure that replaces it
 * when the index cannot be resolved, because an unmarked edge presented as verified is
 * the failure this whole feature exists to prevent.
 */

import { describe, expect, it } from "vitest";

import { callTool } from "./mcp.js";
import { UNRESOLVED_CLASS_DISCLOSURE } from "./mcp/format.js";
import type { FetchLike } from "./mcp/handlers.js";

/** A Stack id with the canonical lowercase-UUID shape the API accepts. */
const STACK = "20efd96a-f6e1-4994-8812-65113f8db4db";

const GATEWAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** One AKS context answer carrying a single edge, as the API would return it. */
const CONTEXT = JSON.stringify({
  query: "how are refunds handled?",
  confidence: "HIGH",
  reasoning: "one edge connects them",
  entities: [
    {
      id: GATEWAY,
      name: "Gateway",
      type: "SYSTEM",
      description: null,
      properties: {},
      confidence: 0.9,
      contributing_documents: [],
      last_seen_at: null,
      source: {},
    },
    {
      id: MODEL,
      name: "Embedding Model",
      type: "TECHNOLOGY",
      description: null,
      properties: {},
      confidence: 0.6,
      contributing_documents: [],
      last_seen_at: null,
      source: {},
    },
  ],
  relationships: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      from_entity_id: GATEWAY,
      to_entity_id: MODEL,
      type: "ABSORBS",
      description: null,
      confidence: 0.75,
      source: {},
    },
  ],
  traversal_path: [],
  confidence_level: "HIGH",
  source_type: "compiled",
});

/** One graph projection whose single edge the ontology refused. */
const GRAPH = JSON.stringify({
  stack_id: STACK,
  node_count: 2,
  edge_count: 1,
  truncated: false,
  nodes: [
    { id: GATEWAY, label: "Gateway", type: "SYSTEM", confidence: 0.9, verified: true, properties: {} },
    {
      id: MODEL,
      label: "Embedding Model",
      type: "TECHNOLOGY",
      confidence: 0.6,
      verified: false,
      properties: {},
    },
  ],
  edges: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      source: GATEWAY,
      target: MODEL,
      type: "ABSORBS",
      confidence: 0.75,
      verified: false,
      ontology_classification: {
        verdict: "rejected",
        reason: "UNKNOWN_RELATIONSHIP_TYPE",
        offending_type: "ABSORBS",
      },
    },
  ],
});

/** A transport that answers the context call and the graph call differently. */
function twoEndpoints(graph?: { status: number; body: string }): FetchLike {
  return async (url) => {
    const body = url.includes("/graph") ? (graph?.body ?? GRAPH) : CONTEXT;
    const status = url.includes("/graph") ? (graph?.status ?? 200) : 200;
    return { status, text: async () => body, json: async () => JSON.parse(body) as unknown };
  };
}

/** `query_stack`'s answer text for one stubbed transport. */
async function ask(fetchImpl: FetchLike): Promise<string> {
  const result = await callTool(
    "query_stack",
    { query: "how are refunds handled?", stackId: STACK },
    { fetchImpl, baseUrl: "https://aks.invalid", apiKey: "not-a-credential" },
  );
  const block = (result.content as { type: string; text: string }[])[0];
  return block?.text ?? "";
}

describe("query_stack and a refused edge", () => {
  it("marks the bullet, resolving the class from the graph projection", async () => {
    const text = await ask(twoEndpoints());

    expect(text).toContain(
      "  • Gateway —[ABSORBS (REJECTED by ontology: UNKNOWN_RELATIONSHIP_TYPE)]→ Embedding Model",
    );
  });

  it("keeps an accepted payload's bullet unchanged", async () => {
    const accepted = JSON.stringify({ ...JSON.parse(GRAPH), edges: [] });

    const text = await ask(twoEndpoints({ status: 200, body: accepted }));

    expect(text).toContain("  • Gateway —[ABSORBS]→ Embedding Model");
    expect(text).not.toContain("REJECTED");
  });

  it("discloses that the classes could not be resolved, instead of marking nothing", async () => {
    const text = await ask(twoEndpoints({ status: 500, body: "boom" }));

    expect(text).toContain(UNRESOLVED_CLASS_DISCLOSURE);
    expect(text).not.toContain("REJECTED");
  });

  it("treats an ABSENT projection route like a failed one, never like a clean one", async () => {
    // A stated decision: 404 gets the same treatment as 500. A deployment where the
    // graph projection is not mounted must not be read as "nothing was refused", which
    // is precisely the silent clean render this disclosure exists to prevent.
    const text = await ask(twoEndpoints({ status: 404, body: '{"detail":"not found"}' }));

    expect(text).toContain(UNRESOLVED_CLASS_DISCLOSURE);
    expect(text).not.toContain("REJECTED");
  });

  it("discloses a truncated index, because an unread edge cannot be cleared", async () => {
    const truncated = JSON.stringify({ ...JSON.parse(GRAPH), truncated: true });

    const text = await ask(twoEndpoints({ status: 200, body: truncated }));

    expect(text).toContain(UNRESOLVED_CLASS_DISCLOSURE);
  });
});
