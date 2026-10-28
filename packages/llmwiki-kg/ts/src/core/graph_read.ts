/**
 * @file packages/llmwiki-kg/ts/src/core/graph_read.ts
 * @description Read operations over a knowledge graph: list entities, find one
 * by name, walk its relationships, and retrieve relevant chunks.
 *
 * ## Why this module exists
 *
 * These four queries were reachable only through Express handlers: `listEntities`,
 * `getEntity` and `traverse` took `(req, res, tx)` and did their SQL inline, so the
 * ONLY way to read the graph was to speak HTTP. That is wrong for every consumer
 * that is already in process — the compiler's `kg` dimension, the MCP server, and
 * any test that wants the answer rather than a status code.
 *
 * The transport concern and the query concern were already separable: the SQL, the
 * row mapping, and the stack resolution all lived in `core/` (`aks_serializers`,
 * `stack_resolver`, `retrieval`), and only the ORCHESTRATION sat in `routes/`. This
 * module moves that orchestration down, so a handler becomes a thin adapter:
 * validate the request, call one function here, encode the result.
 *
 * ## Error style
 *
 * Functions return a discriminated `{ ok }` result rather than throwing, matching
 * `resolveStack`. A missing entity is an EXPECTED outcome of a lookup, not an
 * exception, and the caller needs its own error envelope (an HTTP 404, an MCP tool
 * error, a compiler message), so the shape carries the failure instead of forcing
 * each transport to catch and guess.
 *
 * ## Behaviour is unchanged, deliberately
 *
 * Every SQL statement and every mapping is copied from the handler it replaces.
 * The port is measured against the Python oracle, so this is a MOVE: no query is
 * rewritten, no ordering changed, no default adjusted.
 */

import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import { apiError, type ApiError } from "../errors.js";
import type { AKSTraverseResponseDto } from "../dto.js";
import {
  ENTITY_COLUMNS,
  fetchContributingDocuments,
  rowToEntity,
  toPostgresArrayLiteral,
} from "./aks_serializers.js";
import type { AKSEntityDto } from "../dto.js";
import { resolveStack, type StackResolution } from "./stack_resolver.js";

/** One row of the recursive relationship walk. */
type TraverseRow = {
  from_id: string | null;
  rel_type: string | null;
  to_id: string | null;
  depth: number;
  confidence: number | null;
  from_name: string | null;
  to_name: string | null;
};

/** Why a read produced no value, in transport-neutral terms. */
export type GraphReadFailureCode = "not_found" | "invalid" | "unavailable";

/** A coded read failure. Transports map `code` onto their own surface. */
export interface GraphReadFailure {
  readonly code: GraphReadFailureCode;
  /** Human-readable detail; transports surface it but must not parse it. */
  readonly message: string;
  /** HTTP status the AKS contract uses for this code, for the Express handlers. */
  readonly status: number;
}

/** A read answer: the value, or the coded failure a transport maps. */
export type GraphReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GraphReadFailure };

/**
 * Adapt a coded failure to the FastAPI-shaped error the AKS routes render.
 *
 * The handlers answer `{detail: ...}` with a status; the read layer reports a CODE,
 * because an MCP tool or the compiler has no status to give. Keeping the mapping
 * here means the code stays the single source of truth and the wire shape derives
 * from it, rather than the two drifting.
 *
 * @param failure - Coded failure from this module.
 * @returns The same information as an `ApiError`.
 */
export function toApiError(failure: GraphReadFailure): ApiError {
  return apiError(failure.status, failure.message);
}

/** Map an `ApiError` status onto a coded failure. */
function codeOf(error: ApiError): GraphReadFailureCode {
  return error.status === 404 ? "not_found" : error.status === 422 ? "invalid" : "unavailable";
}

/** Build a coded failure, deriving the HTTP status from the code. */
function readFailure(code: GraphReadFailureCode, message: string): GraphReadFailure {
  const status = code === "not_found" ? 404 : code === "invalid" ? 422 : 503;
  return { code, message, status };
}

/** Filters for {@link listEntities}. */
export interface ListEntitiesQuery {
  readonly stackId: string | null;
  readonly domain: string | null;
  readonly type: string | null;
  readonly minConfidence: number;
  readonly limit: number;
}

/** Parameters for {@link traverseGraph}. */
export interface TraverseQuery {
  readonly start: string;
  readonly stackId: string | null;
  readonly domain: string | null;
  readonly maxDepth: number;
  readonly relationshipTypes: string | null;
}

/** The walk plus the counts the oracle reports alongside it. */
export interface TraverseAnswer {
  readonly start: string;
  readonly maxDepth: number;
  readonly steps: AKSTraverseResponseDto["steps"];
  readonly entityCount: number;
}

/** Narrow a `text` column the walk's joins cannot have nulled. */
function requireText(value: string | null, column: string): string {
  if (value === null) throw new Error(`unexpected null ${column} in walk result`);
  return value;
}

/** Narrow a `real` column the walk's joins cannot have nulled. */
function requireNumber(value: number | null, column: string): number {
  if (value === null) throw new Error(`unexpected null ${column} in walk result`);
  return value;
}

/**
 * Parse `relationship_types`, returning `null` when the filter is disabled.
 *
 * `relationship_types.split(",")` with empty segments dropped, so `","` yields an
 * empty list — matching nothing — while an absent or empty parameter disables the
 * filter entirely. Both measured on the oracle.
 */
export function parseTypeFilter(relationshipTypes: string | null): string[] | null {
  if (relationshipTypes === null || relationshipTypes === "") return null;
  return relationshipTypes
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Map a walk row to the response shape. */
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

/**
 * The recursive walk statement for one anchor, depth and type filter.
 *
 * Deliberately left as one statement: it is a single `with recursive` CTE whose
 * seed, recursion and final projection all reference `walk`, so splitting it would
 * obscure rather than clarify the query.
 */
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

/** Run the walk from an anchor entity. */
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

/**
 * List a stack's entities, highest confidence first.
 *
 * @param tx - Transaction carrying the read.
 * @param query - Stack identity, optional type filter, confidence floor, limit.
 * @returns The entities, or the error a transport should encode.
 */
export async function readEntities(
  tx: Database,
  query: ListEntitiesQuery,
): Promise<GraphReadResult<readonly AKSEntityDto[]>> {
  const stack = await resolveStack(tx, query.stackId, query.domain);
  if (!stack.ok) return { ok: false, error: readFailure(codeOf(stack.error), stack.error.body.detail) };

  const hasType = query.type !== null && query.type !== "";
  const typeClause = hasType ? sql`and type = ${query.type}` : sql.empty();

  const rows = await tx.execute<Parameters<typeof rowToEntity>[0]>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stack.stack.id}
      and confidence >= ${query.minConfidence}
      ${typeClause}
    order by confidence desc, name
    limit ${query.limit}
  `);

  if (rows.length === 0) return { ok: true, value: [] };

  const contributing = await fetchContributingDocuments(
    tx,
    rows.map((row) => row.id),
  );

  return {
    ok: true,
    value: rows.map((row) => rowToEntity(row, contributing.get(row.id) ?? [])),
  };
}

/**
 * One entity by exact, case-insensitive name.
 *
 * The lookup is `lower(name) = lower(%s)`, so `gateway` finds `Gateway`. It is an
 * equality test on the whole name, not a prefix or trigram match — a partial name
 * is a 404.
 *
 * @param tx - Transaction carrying the read.
 * @param stackId - Stack identity, or null when `domain` names it instead.
 * @param domain - Stack slug, used only when `stackId` is null.
 * @param name - Requested entity name.
 * @returns The entity, or the error a transport should encode.
 */
export async function readEntityByName(
  tx: Database,
  stackId: string | null,
  domain: string | null,
  name: string,
): Promise<GraphReadResult<AKSEntityDto>> {
  const stack = await resolveStack(tx, stackId, domain);
  if (!stack.ok) return { ok: false, error: readFailure(codeOf(stack.error), stack.error.body.detail) };

  const rows = await tx.execute<Parameters<typeof rowToEntity>[0]>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stack.stack.id} and lower(name) = lower(${name})
  `);
  const row = rows[0];
  if (row === undefined) {
    return { ok: false, error: readFailure("not_found", `Entity '${name}' not found in Stack`) };
  }

  const contributing = await fetchContributingDocuments(tx, [row.id]);
  return { ok: true, value: rowToEntity(row, contributing.get(row.id) ?? []) };
}

/**
 * Walk outward from one entity, breadth-first, up to a depth.
 *
 * @param tx - Transaction carrying the read.
 * @param query - Anchor name, stack identity, depth, and optional type filter.
 * @returns The walk, or the error a transport should encode.
 */
export async function traverseGraph(
  tx: Database,
  query: TraverseQuery,
): Promise<GraphReadResult<TraverseAnswer>> {
  const stack = await resolveStack(tx, query.stackId, query.domain);
  if (!stack.ok) return { ok: false, error: readFailure(codeOf(stack.error), stack.error.body.detail) };

  const startRow = await findStartEntity(tx, stack.stack.id, query.start);
  if (startRow === null) {
    return {
      ok: false,
      error: readFailure("not_found", `Entity '${query.start}' not found in Stack`),
    };
  }

  const steps = await walkGraph(
    tx,
    stack.stack.id,
    startRow,
    query.maxDepth,
    parseTypeFilter(query.relationshipTypes),
  );

  return {
    ok: true,
    value: {
      start: startRow.name,
      maxDepth: query.maxDepth,
      steps,
      entityCount: new Set(
        [startRow.name, ...steps.flatMap((step) => [step.from_entity, step.to_entity])],
      ).size,
    },
  };
}

/** Re-exported so callers do not need to reach into two modules. */
export type { StackResolution };
