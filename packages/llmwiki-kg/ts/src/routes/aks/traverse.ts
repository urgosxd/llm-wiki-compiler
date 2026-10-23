/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/traverse.ts
 * @description `GET /aks/v1/traverse` — the recursive graph walk.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import {
  toPostgresArrayLiteral,
} from "../../core/aks_serializers.js";
import { parseTypeFilter, toApiError, traverseGraph } from "../../core/graph_read.js";
import type { Database } from "../../db.js";
import { AKSTraverseResponse } from "../../dto.js";
import type { AKSTraverseResponseDto } from "../../dto.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { isFilterSet, sendApiError, sendValidationError } from "./response.js";
import { TRAVERSE_QUERY_KEYS, TraverseQuery, readQuery } from "./query-params.js";

// GET /aks/v1/traverse
// ---------------------------------------------------------------------------

/** One row of the recursive walk, after the entity-name joins. */
/**
 * `GET /aks/v1/traverse` — breadth-first walk over typed relationships.
 *
 * The walk is one `with recursive` CTE, exactly as in Python:
 *
 * - the anchor row carries `from_id = null`, which is why the outer select
 *   filters `where w.from_id is not null` — the anchor exists only to seed
 *   `visited` and `depth`, and emitting it as a step would produce a bogus
 *   self-edge;
 * - `not r.to_entity_id = any(w.visited)` makes the walk cycle-safe — the visited
 *   array travels *with each path*, so it rejects a repeat within one path. It is
 *   deliberately **not** a global visited set: a diamond yields one step per path,
 *   which is why the same target can appear at two depths. Measured on the
 *   oracle: with `Gateway -> Embedding Model -> Rate Limit` and a direct
 *   `Gateway -> Rate Limit` edge, depth 2 returns **three** steps, two of them
 *   ending at `Rate Limit`;
 * - edges are followed in one direction only (`r.from_entity_id = w.current`), so
 *   a one-way edge is not traversable backwards.
 *
 * `entity_count` counts the start entity plus every endpoint named by a step, as
 * a **set** — not `len(steps) + 1`, which would double count a diamond. Measured
 * three ways: a two-hop chain gives 2 entities at depth 1 and 3 at depth 2; the
 * three-step diamond above still reports 3; a cycle back to the start adds no
 * entity.
 *
 * A start entity that does not exist is a **404**, not an empty result: the
 * oracle answers `Entity '<name>' not found in Stack`, the same wording the
 * single-entity endpoint uses.
 */
export async function traverse(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, TRAVERSE_QUERY_KEYS);
  const query = TraverseQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }
  const {
    start,
    stack_id: stackId,
    domain,
    max_depth: maxDepth,
    relationship_types: relationshipTypes,
  } = query.data;

  // The walk lives in `core/graph_read.ts`, so MCP and the `kg` dimension can
  // traverse without an Express request. This handler only encodes the answer.
  const result = await traverseGraph(tx, {
    start,
    stackId,
    domain,
    maxDepth,
    relationshipTypes,
  });
  if (!result.ok) {
    sendApiError(res, toApiError(result.error));
    return;
  }

  res.json(
    AKSTraverseResponse.parse({
      start: result.value.start,
      max_depth: result.value.maxDepth,
      steps: result.value.steps,
      entity_count: result.value.entityCount,
    }),
  );
}

/**
 * Narrows a `text` column that the walk's joins cannot have nulled.
 *
 * A null here would mean `ontology_entities` lost a row between the anchor and
 * the outer select, which no interleaving can do inside one statement. Throwing
 * keeps the failure visible instead of silently emitting `null` into a `str`
 * field, which the oracle would answer with a 500 anyway.
 */
export function requireText(value: string | null, column: string): string {
  if (value === null) {
    throw new TypeError(`traverse produced a null ${column}`);
  }
  return value;
}

/** Same contract as {@link requireText}, for the `real` confidence column. */
export function requireNumber(value: number | null, column: string): number {
  if (value === null) {
    throw new TypeError(`traverse produced a null ${column}`);
  }
  return value;
}
