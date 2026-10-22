/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/traverse.ts
 * @description `GET /aks/v1/traverse` — the recursive graph walk.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import {
  toPostgresArrayLiteral,
} from "../../core/aks_serializers.js";
import { resolveStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { AKSTraverseResponse } from "../../dto.js";
import type { AKSTraverseResponseDto } from "../../dto.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { isFilterSet, sendApiError, sendValidationError } from "./response.js";
import { TRAVERSE_QUERY_KEYS, TraverseQuery, readQuery } from "./query-params.js";

// GET /aks/v1/traverse
// ---------------------------------------------------------------------------

/** One row of the recursive walk, after the entity-name joins. */
type TraverseRow = {
  from_id: string | null;
  rel_type: string | null;
  to_id: string | null;
  depth: number;
  confidence: number | null;
  from_name: string | null;
  to_name: string | null;
};

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
/** Parse `relationship_types`, returning `null` when the filter is disabled. */
function parseTypeFilter(relationshipTypes: string | null): string[] | null {
  // `relationship_types.split(",")` with empty segments dropped, so `","` yields
  // an empty list — matching nothing — while an absent or empty parameter
  // disables the filter entirely. Both measured.
  if (!isFilterSet(relationshipTypes)) return null;
  return relationshipTypes
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Resolve the anchor entity, or `null` when the stack has no such name. */
async function findStartEntity(
  tx: Database,
  stackId: string,
  start: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await tx.execute<{ id: string; name: string }>(sql`
    select id, name from ontology_entities
    where stack_id = ${stackId} and lower(name) = lower(${start})
  `);
  return rows[0] ?? null;
}

/** Run the recursive walk and map rows to response steps. */
/** Build the recursive walk statement for one anchor, depth and type filter. */
function walkStatement(
  stackId: string,
  startId: string,
  maxDepth: number,
  typeClause: ReturnType<typeof sql>,
) {
  return sql`
    with recursive walk as (
      select
        ${startId}::uuid as current_entity_id,
        array[${startId}::uuid] as visited,
        null::uuid as from_id,
        null::text as rel_type,
        null::uuid as to_id,
        null::real as confidence,
        0 as depth
      union all
      select
        r.to_entity_id,
        w.visited || r.to_entity_id,
        r.from_entity_id,
        r.type,
        r.to_entity_id,
        r.confidence,
        w.depth + 1
      from walk w
      join ontology_relationships r
        on r.from_entity_id = w.current_entity_id
      where r.stack_id = ${stackId}
        and not r.to_entity_id = any(w.visited)
        and w.depth < ${maxDepth}
        ${typeClause}
    )
    select
      w.from_id, w.rel_type, w.to_id, w.depth, w.confidence,
      ef.name as from_name, et.name as to_name
    from walk w
    left join ontology_entities ef on ef.id = w.from_id
    left join ontology_entities et on et.id = w.to_id
    where w.from_id is not null
    order by w.depth, ef.name
  `;
}

/** Map a walk row to the response shape, insisting on the non-null columns. */
function rowToStep(row: TraverseRow): AKSTraverseResponseDto["steps"][number] {
  return {
    from_entity: requireText(row.from_name, "from_name"),
    relationship: requireText(row.rel_type, "rel_type"),
    to_entity: requireText(row.to_name, "to_name"),
    depth: row.depth,
    // `real` is not null in the schema, and the anchor row is already excluded
    // above, so a null here would mean the join dropped its row.
    confidence: Number(requireNumber(row.confidence, "confidence")),
  };
}

async function walkGraph(
  tx: Database,
  stackId: string,
  startRow: { id: string; name: string },
  maxDepth: number,
  typesList: readonly string[] | null,
): Promise<AKSTraverseResponseDto["steps"]> {
  const typeClause =
    typesList === null
      ? sql.empty()
      : sql`and r.type = any(${toPostgresArrayLiteral(typesList)}::text[])`;

  const rows = await tx.execute<TraverseRow>(
    walkStatement(stackId, startRow.id, maxDepth, typeClause),
  );
  return rows.map(rowToStep);
}

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

  const stack = await resolveStack(tx, stackId, domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const startRow = await findStartEntity(tx, stack.stack.id, start);
  if (startRow === null) {
    sendApiError(res, apiError(404, `Entity '${start}' not found in Stack`));
    return;
  }

  const steps = await walkGraph(
    tx, stack.stack.id, startRow, maxDepth, parseTypeFilter(relationshipTypes),
  );


  res.json(
    AKSTraverseResponse.parse({
      start: startRow.name,
      max_depth: maxDepth,
      steps,
      entity_count: new Set(
        [startRow.name, ...steps.flatMap((step) => [step.from_entity, step.to_entity])],
      ).size,
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
