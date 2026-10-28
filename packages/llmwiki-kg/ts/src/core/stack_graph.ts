/**
 * @file packages/llmwiki-kg/ts/src/core/stack_graph.ts
 * @description Reads one Stack's knowledge graph as a node-link payload.
 *
 * ## Why this module exists
 *
 * The KG dimension writes `ontology_entities` and `ontology_relationships`, and
 * every existing read path returns them in the **AKS** shape: an entity carries a
 * nested `source` block, an edge is keyed by `from_entity_id` / `to_entity_id`.
 * That shape is measured against the Python oracle and cannot move. A renderer,
 * though, wants `nodes` and `edges` with `source` / `target`, and a client that
 * adapts the bundle by hand re-implements the same projection once per consumer.
 *
 * So the projection lives here, once, on the server: the same rows, reshaped for
 * drawing, and nothing else.
 *
 * ## This is an extension, not a port
 *
 * Unlike `dto.ts`, which mirrors `app/models/api.py` field for field, this
 * response has no Python counterpart, so there is no oracle to measure against.
 * That is why the schemas below are plain Zod instead of the `pydantic*`
 * primitives: those exist to reproduce Pydantic's *error* vocabulary, and no
 * caller compares this endpoint's validation against FastAPI.
 *
 * ## Graph invariants the payload guarantees
 *
 * 1. **An edge never dangles.** Edges are selected by endpoint survival, so a
 *    truncated or filtered-out node cannot leave an edge pointing at an id the
 *    caller does not have. A renderer can therefore draw every edge it receives.
 * 2. **`truncated` means "there was more", never "the data is unreliable".** It
 *    is true only when the entity count exceeded `limit`; a `min_confidence`
 *    filter that removes rows is a filter, not a truncation.
 * 3. **Counts describe the payload, not the Stack.** `node_count` and
 *    `edge_count` are what this response carries, so they always equal the array
 *    lengths above them. A caller wanting Stack-wide totals asks the export.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { toPostgresArrayLiteral } from "./aks_serializers.js";
import { resolveStack } from "./stack_resolver.js";
import type { Database } from "../db.js";
import type { ApiError } from "../errors.js";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/**
 * One drawable entity.
 *
 * `label` rather than `name`, and `id`/`source`/`target` rather than
 * `from_entity_id`/`to_entity_id`: this is the vocabulary of node-link data, and
 * a renderer should not have to know that the rows came from an ontology table.
 */
export const StackGraphNode = z.object({
  id: z.uuid(),
  label: z.string(),
  type: z.string(),
  confidence: z.number(),
  verified: z.boolean(),
  properties: z.record(z.string(), z.unknown()),
});

/** One drawable relationship: a directed edge between two node ids. */
export const StackGraphEdge = z.object({
  id: z.uuid(),
  source: z.uuid(),
  target: z.uuid(),
  type: z.string(),
  confidence: z.number(),
  verified: z.boolean(),
});

/** The whole payload. Declaration order is the JSON key order. */
export const StackGraph = z.object({
  stack_id: z.uuid(),
  node_count: z.number().int(),
  edge_count: z.number().int(),
  truncated: z.boolean(),
  nodes: z.array(StackGraphNode),
  edges: z.array(StackGraphEdge),
});

export type StackGraphDto = z.infer<typeof StackGraph>;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** An `ontology_entities` row as this module selects it. */
type NodeRow = {
  id: string;
  name: string;
  type: string;
  properties: unknown;
  confidence: number;
  verified: boolean;
};

/** An `ontology_relationships` row as this module selects it. */
type EdgeRow = {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  type: string;
  confidence: number;
  verified: boolean;
};

/** What a caller may narrow. `stackId` has already been validated as a UUID. */
export interface StackGraphRequest {
  readonly stackId: string;
  /** Inclusive lower bound on entity confidence, in `[0, 1]`. */
  readonly minConfidence: number;
  /** Maximum number of nodes; edges follow their endpoints. */
  readonly limit: number;
}

/** A payload, or the error the transport should render instead. */
export type StackGraphResult =
  | { readonly ok: true; readonly value: StackGraphDto }
  | { readonly ok: false; readonly error: ApiError };

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Columns every node read selects.
 *
 * `description` and the provenance columns are deliberately absent: a renderer
 * draws a label, a type and a weight, and the rest would inflate every payload
 * for callers that never look at it. A caller needing them reads `/aks/v1`.
 */
const NODE_COLUMNS = "id, name, type, properties, confidence, verified";

/** Columns every edge read selects. */
const EDGE_COLUMNS = "id, from_entity_id, to_entity_id, type, confidence, verified";

/** True when `value` is a plain JSON object, which is what `properties` must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Counts the entities a filter selects, ignoring `limit`.
 *
 * A separate statement rather than `rows.length === limit`, because those two
 * agree only by accident: at exactly `limit` matching rows the page is complete
 * and `truncated` must be false, while one more row makes it true. Comparing the
 * count is the only reading that distinguishes them.
 */
async function countNodes(
  tx: Database,
  stackId: string,
  minConfidence: number,
): Promise<number> {
  const rows = await tx.execute<{ total: number }>(sql`
    select count(*)::int as total
    from ontology_entities
    where stack_id = ${stackId}
      and confidence >= ${minConfidence}
  `);
  return rows[0]?.total ?? 0;
}

/**
 * Loads at most `limit` nodes, most confident first.
 *
 * `order by confidence desc, name` is the same deterministic order
 * `/aks/v1/entities` uses, and it matters more here than there: which nodes
 * survive truncation decides which edges survive with them, so an unstable order
 * would make two identical requests return two different graphs. `name` is the
 * tie-break that makes the truncation boundary reproducible.
 */
async function loadNodes(
  tx: Database,
  stackId: string,
  minConfidence: number,
  limit: number,
): Promise<NodeRow[]> {
  return tx.execute<NodeRow>(sql`
    select ${sql.raw(NODE_COLUMNS)}
    from ontology_entities
    where stack_id = ${stackId}
      and confidence >= ${minConfidence}
    order by confidence desc, name
    limit ${limit}
  `);
}

/**
 * Loads the edges whose **both** endpoints are in `nodeIds`.
 *
 * Filtering on both ends is what makes the "no dangling edge" guarantee hold.
 * It also means an edge is dropped when either endpoint was truncated away,
 * which is the intended reading: an edge to a node the caller cannot draw is not
 * drawable data. `nodeIds` empty short-circuits so the statement never builds an
 * `any({})` literal.
 */
async function loadEdges(
  tx: Database,
  stackId: string,
  nodeIds: readonly string[],
): Promise<EdgeRow[]> {
  if (nodeIds.length === 0) return [];
  return tx.execute<EdgeRow>(sql`
    select ${sql.raw(EDGE_COLUMNS)}
    from ontology_relationships
    where stack_id = ${stackId}
      and from_entity_id = any(${toPostgresArrayLiteral(nodeIds)}::uuid[])
      and to_entity_id = any(${toPostgresArrayLiteral(nodeIds)}::uuid[])
  `);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Maps an entity row onto a node.
 *
 * `properties` falls back to `{}` for SQL NULL, the same rule `rowToEntity`
 * applies: a node whose `properties` were `null` would force every renderer to
 * null-check a field the column defaults to an empty object anyway.
 */
function rowToNode(row: NodeRow): StackGraphDto["nodes"][number] {
  return {
    id: row.id,
    label: row.name,
    type: row.type,
    confidence: Number(row.confidence),
    verified: Boolean(row.verified),
    properties: isPlainObject(row.properties) ? row.properties : {},
  };
}

/** Maps a relationship row onto an edge. */
function rowToEdge(row: EdgeRow): StackGraphDto["edges"][number] {
  return {
    id: row.id,
    source: row.from_entity_id,
    target: row.to_entity_id,
    type: row.type,
    confidence: Number(row.confidence),
    verified: Boolean(row.verified),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reads one Stack's graph, filtered and bounded.
 *
 * The Stack is resolved first, which under row-level security is also what binds
 * the tenant: an unknown id therefore produces its 404 from the same resolver
 * every other Stack route uses, rather than from a guard here that could
 * disagree with it.
 *
 * Everything after resolution runs inside the caller's transaction, so the count,
 * the page and the edges describe one consistent snapshot — without that, a
 * concurrent ingest between the count and the page would report `truncated: true`
 * on a graph that is complete.
 *
 * @param tx - Request transaction, tenant unbound until resolution runs.
 * @param request - A validated Stack id plus the two narrowing bounds.
 * @returns The payload, or the resolver's error for the transport to render.
 */
export async function readStackGraph(
  tx: Database,
  request: StackGraphRequest,
): Promise<StackGraphResult> {
  const resolved = await resolveStack(tx, request.stackId, null);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const stackId = resolved.stack.id;
  const total = await countNodes(tx, stackId, request.minConfidence);
  const nodeRows = await loadNodes(tx, stackId, request.minConfidence, request.limit);
  const edgeRows = await loadEdges(tx, stackId, nodeRows.map((row) => row.id));

  // Parsed, not hand-built: the schema fixes key order, so the wire contract is
  // declared in exactly one place instead of being implied by this literal.
  const value = StackGraph.parse({
    stack_id: stackId,
    node_count: nodeRows.length,
    edge_count: edgeRows.length,
    truncated: total > nodeRows.length,
    nodes: nodeRows.map(rowToNode),
    edges: edgeRows.map(rowToEdge),
  });

  return { ok: true, value };
}
