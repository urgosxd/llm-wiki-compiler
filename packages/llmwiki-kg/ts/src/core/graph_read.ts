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
 *
 * ## Reading a graph that holds classified AND free items
 *
 * The open-classification work made two kinds of row legal in one Stack:
 * classified rows (a catalog type was assigned) and free ones (a decision was
 * recorded and it was not a catalog type). Three rules follow, and they are the
 * reason this module no longer simply filters `type`:
 *
 * 1. **A canonical-type filter matches the CATALOG DECISION, not the label.**
 *    `type` is the projection/display column, so a free entity whose extractor
 *    proposal happens to read `Role` stores `type = 'ROLE'`. Comparing `type`
 *    would answer `?type=ROLE` with an item that was explicitly decided NOT to be
 *    a Role. The filter therefore reads `canonical_type` for classified rows and
 *    `type` only for rows with NO recorded decision — see
 *    {@link canonicalTypeClause} for why that second branch is not a loophole.
 * 2. **No filter means both kinds.** General reads and walks carry no state
 *    predicate at all, so free nodes and free edges are ordinary graph members.
 * 3. **A row publishes its state when it has one.** The AKS DTO's only extension
 *    point is the entity's `properties` object, so
 *    {@link withClassificationState} adds {@link CLASSIFICATION_PROPERTY_KEY}
 *    there — never a new top-level field, which the schema would strip anyway.
 *
 * Name lookups became ambiguous when the migration replaced name-only uniqueness
 * with the identity key, so every `lower(name)` match is now resolved through
 * {@link pickEntityIdByName}: a stated total order instead of `rows[0]`.
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
  /**
   * Which classification states to return, or `null`/absent for every one of them.
   * `free` selects both free states; see `CLASSIFICATION_STATE_FILTERS`.
   *
   * Optional on purpose: it is a NEW filter, so a caller that predates it keeps
   * compiling and keeps the answer it always got — both kinds of row.
   */
  readonly classificationState?: string | null;
}

/**
 * The classification states a row may carry, mirroring the SQL check constraints.
 *
 * Declared here rather than imported from `schema.ts` so this module stays a pure
 * read layer; the two lists are pinned against each other by the route tests that
 * write each state and read it back.
 */
export const CLASSIFICATION_STATES = [
  "classified",
  "free_no_match",
  "free_uncertain",
  "pending",
  "failed",
] as const;

/** One row's classification state, once it is known to be a legal value. */
export type ClassificationState = (typeof CLASSIFICATION_STATES)[number];

/**
 * The two states the word "free" covers.
 *
 * They mean "a decision was made and no catalog type fitted" — one by absence of a
 * match, one by ambiguity. `pending` and `failed` are NOT here: in those states no
 * decision exists yet, and reporting an unanswered question as an answer about the
 * catalog would be exactly the confusion the feature forbids.
 */
export const FREE_CLASSIFICATION_STATES = ["free_no_match", "free_uncertain"] as const;

/**
 * The `properties` key through which reads publish an entity's classification.
 *
 * A reserved key of this application, chosen for the same reason the migration
 * reserves the `Unclassified` type label: a consumer must be able to tell our
 * metadata from an extractor's own property. AKS permits `properties` on an
 * entity and on nothing else, so this is the only extension point available.
 */
export const CLASSIFICATION_PROPERTY_KEY = "kg_classification";

/** The classification columns every entity read selects beside `ENTITY_COLUMNS`. */
export const CLASSIFICATION_COLUMNS =
  "classification_state, canonical_type, proposed_type, support_state";

/**
 * The classification columns of one row, as any read path sees them.
 *
 * A type alias rather than an interface on purpose: `execute<T>` constrains `T` to
 * `Record<string, unknown>`, and TypeScript infers an implicit index signature for an
 * object type alias but not for an interface.
 */
export type ClassificationColumns = {
  readonly classification_state: string | null;
  readonly canonical_type: string | null;
  readonly proposed_type: string | null;
  readonly support_state: string | null;
};

/** Why a row is not confirmed classified, as a stable machine-readable code. */
export type ClassificationReason =
  | "no_canonical_type_matched"
  | "classification_uncertain"
  | "classification_pending"
  | "classification_failed";

/** The reason each state carries; `classified` needs none. */
const CLASSIFICATION_REASONS: Readonly<Record<ClassificationState, ClassificationReason | null>> = {
  classified: null,
  free_no_match: "no_canonical_type_matched",
  free_uncertain: "classification_uncertain",
  pending: "classification_pending",
  failed: "classification_failed",
};

/** What a classified-or-free row publishes inside `properties`. */
export interface ClassificationBlock {
  readonly state: ClassificationState;
  readonly classified: boolean;
  readonly is_free: boolean;
  readonly reason: ClassificationReason | null;
  readonly canonical_type: string | null;
  readonly proposed_type: string | null;
  readonly support_state: string | null;
  readonly name_matches?: number;
}

/**
 * Narrows a stored state to the declared set, or `null` when it is absent.
 *
 * The SQL check constraint already forbids any other value, so an unrecognised
 * string can only mean a row written by a schema this build does not know. It is
 * reported as "no recorded decision" rather than thrown on: a read endpoint must
 * not fail because one row is ahead of its reader.
 */
function knownState(value: string | null): ClassificationState | null {
  return value !== null && (CLASSIFICATION_STATES as readonly string[]).includes(value)
    ? (value as ClassificationState)
    : null;
}

/** The block one row publishes, or `null` when no decision was recorded. */
export function classificationBlock(row: ClassificationColumns): ClassificationBlock | null {
  const state = knownState(row.classification_state);
  if (state === null) return null;
  return {
    state,
    classified: state === "classified",
    is_free: (FREE_CLASSIFICATION_STATES as readonly string[]).includes(state),
    reason: CLASSIFICATION_REASONS[state],
    canonical_type: row.canonical_type,
    proposed_type: row.proposed_type,
    support_state: row.support_state,
  };
}

/**
 * Publish one row's classification inside the entity DTO's `properties`.
 *
 * Nothing is published for a row with no recorded decision and no shared name:
 * a reader learns nothing from an empty block, and leaving `properties` untouched
 * keeps the response of every pre-classification row byte-identical to what it
 * was before this feature. `nameMatches` above one is published even without a
 * decision, because a shared name is itself something the caller must see — it is
 * how `GET /entities/{name}` says "this answer was chosen out of several".
 *
 * @param entity - Parsed entity DTO.
 * @param row - The classification columns of the same row.
 * @param nameMatches - How many rows in the Stack share the requested name.
 * @returns The entity, with `properties` extended when there is something to say.
 */
export function withClassificationState<E extends { readonly properties: Record<string, unknown> }>(
  entity: E,
  row: ClassificationColumns,
  nameMatches = 1,
): E {
  const block = classificationBlock(row);
  if (block === null && nameMatches < 2) return entity;
  const published: Record<string, unknown> =
    block === null
      ? { name_matches: nameMatches }
      : nameMatches > 1
        ? { ...block, name_matches: nameMatches }
        : { ...block };
  return { ...entity, properties: { ...entity.properties, [CLASSIFICATION_PROPERTY_KEY]: published } };
}

/**
 * The canonical-type filter: classified matches only, plus undecided legacy rows.
 *
 * `classification_state = 'classified' and canonical_type = <requested>` is the
 * rule the feature requires: a filter by canonical type answers with items the
 * catalog actually classified that way.
 *
 * The second branch is a compatibility rule, not a hole. A row with NO recorded
 * decision is not a free row — free means "a decision was made and no catalog type
 * fitted" — and such rows are written by surfaces this feature does not change:
 * human-reviewed backfeed entities, and rows predating the classification
 * migration. Those readers were always answered through the `type` label, and
 * dropping them would silently shrink what `?type=` returns for exactly the facts a
 * human verified. A row with a RECORDED decision therefore never falls back to its
 * label: that is the case that would present a free item as a classified one.
 *
 * @param type - Requested canonical type name.
 * @returns The SQL conjunction to splice into the entity query.
 */
function canonicalTypeClause(type: string) {
  return sql`and (
      (classification_state = 'classified' and canonical_type = ${type})
      or (classification_state is null and type = ${type})
    )`;
}

/**
 * The state filter behind `?classification_state=`, `free` being the union value.
 *
 * @param state - One value of `CLASSIFICATION_STATE_FILTERS`.
 * @returns The SQL conjunction to splice into the entity query.
 */
function classificationStateClause(state: string) {
  if (state === "free") {
    return sql`and classification_state in ('free_no_match', 'free_uncertain')`;
  }
  return sql`and classification_state = ${state}`;
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

/** What one case-insensitive name lookup found. */
export type EntityNamePick = ClassificationColumns & {
  readonly id: string;
  readonly name: string;
  /** How many rows in the Stack share the requested name, at least one. */
  readonly matches: number;
};

/**
 * The deterministic pick among rows sharing one case-insensitive name.
 *
 * This is the ONE name-resolution rule every read path uses. Before the identity
 * migration, `unique (stack_id, name)` meant a `lower(name)` match could yield at
 * most one row, so `rows[0]` was unambiguous; once homonyms became legal, an
 * unordered match returns whichever row the plan happens to hand back first. Two
 * endpoints could then disagree about who "the" `Gateway` is between one request
 * and the next.
 *
 * The order, stated instead of inherited:
 *
 * 1. a row whose own decision says `classified` wins, because a catalog decision is
 *    the strongest available statement about what the mention means;
 * 2. then the most confident row, which is the tie-break every other read already
 *    uses (`readEntities`);
 * 3. then `id`, which is unique, so the order is total and the answer can never
 *    depend on the plan.
 *
 * `matches` is returned beside the pick so a caller can report that the name is
 * shared instead of guessing silently between homonyms.
 *
 * @param tx - Transaction carrying the read.
 * @param stackId - Stack to search.
 * @param name - Requested name, matched case-insensitively and in full.
 * @returns The picked row's identity and classification, or `null` when absent.
 */
export async function pickEntityIdByName(
  tx: Database,
  stackId: string,
  name: string,
): Promise<EntityNamePick | null> {
  const rows = await tx.execute<EntityNamePick>(sql`
    select id, name, ${sql.raw(CLASSIFICATION_COLUMNS)}, (count(*) over ())::int as matches
    from ontology_entities
    where stack_id = ${stackId} and lower(name) = lower(${name})
    order by
      case when classification_state = 'classified' then 0 else 1 end,
      confidence desc,
      id
    limit 1
  `);
  return rows[0] ?? null;
}

/** Resolve the anchor entity, or `null` when the stack has no such name. */
async function findStartEntity(
  tx: Database,
  stackId: string,
  start: string,
): Promise<{ id: string; name: string } | null> {
  const pick = await pickEntityIdByName(tx, stackId, start);
  return pick === null ? null : { id: pick.id, name: pick.name };
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

/**
 * The canonical-relation filter for the walk: classified edges only, plus
 * undecided legacy rows.
 *
 * Same rule and same compatibility branch as {@link canonicalTypeClause}, applied
 * to relationships: `relationship_types` names canonical relation types, so a free
 * edge whose predicate was stored with a canonical-looking label must not answer
 * it, and a classified edge must be found by the type the catalog assigned it.
 *
 * @param types - Every requested canonical relation type.
 * @returns The SQL conjunction to splice into the walk's recursive term.
 */
function canonicalRelationClause(types: readonly string[]) {
  const literal = toPostgresArrayLiteral(types);
  return sql`and (
      (r.classification_state = 'classified' and r.canonical_type = any(${literal}::text[]))
      or (r.classification_state is null and r.type = any(${literal}::text[]))
    )`;
}

/** Run the walk from an anchor entity. */
async function walkGraph(
  tx: Database,
  stackId: string,
  startRow: { id: string; name: string },
  maxDepth: number,
  typesList: readonly string[] | null,
): Promise<AKSTraverseResponseDto["steps"]> {
  const typeClause = typesList === null ? sql.empty() : canonicalRelationClause(typesList);
  const rows = await tx.execute<TraverseRow>(
    walkStatement(stackId, startRow.id, maxDepth, typeClause),
  );
  return rows.map(rowToStep);
}

/**
 * List a stack's entities, highest confidence first.
 *
 * Both classified and free rows are returned: with no type and no state filter the
 * query carries no classification predicate at all, because a free entity is an
 * ordinary graph member, not a quarantine. A `type` filter is answered by the
 * catalog decision (see {@link canonicalTypeClause}) and a `classificationState`
 * filter by the recorded state.
 *
 * @param tx - Transaction carrying the read.
 * @param query - Stack identity, optional type and state filters, confidence floor, limit.
 * @returns The entities, or the error a transport should encode.
 */
export async function readEntities(
  tx: Database,
  query: ListEntitiesQuery,
): Promise<GraphReadResult<readonly AKSEntityDto[]>> {
  const stack = await resolveStack(tx, query.stackId, query.domain);
  if (!stack.ok) return { ok: false, error: readFailure(codeOf(stack.error), stack.error.body.detail) };

  const type = query.type ?? "";
  const state = query.classificationState ?? null;
  const typeClause = type === "" ? sql.empty() : canonicalTypeClause(type);
  const stateClause = state === null ? sql.empty() : classificationStateClause(state);

  const rows = await tx.execute<Parameters<typeof rowToEntity>[0] & ClassificationColumns>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}, ${sql.raw(CLASSIFICATION_COLUMNS)}
    from ontology_entities
    where stack_id = ${stack.stack.id}
      and confidence >= ${query.minConfidence}
      ${typeClause}
      ${stateClause}
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
    value: rows.map((row) =>
      withClassificationState(rowToEntity(row, contributing.get(row.id) ?? []), row),
    ),
  };
}

/**
 * One entity by exact, case-insensitive name.
 *
 * The lookup is `lower(name) = lower(%s)`, so `gateway` finds `Gateway`. It is an
 * equality test on the whole name, not a prefix or trigram match — a partial name
 * is a 404. When several rows share the name, {@link pickEntityIdByName} chooses
 * deterministically and the answer says so through `name_matches` rather than
 * pretending the name identifies one row.
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

  const pick = await pickEntityIdByName(tx, stack.stack.id, name);
  if (pick === null) {
    return { ok: false, error: readFailure("not_found", `Entity '${name}' not found in Stack`) };
  }

  const rows = await tx.execute<Parameters<typeof rowToEntity>[0]>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where id = ${pick.id}
  `);
  const row = rows[0];
  if (row === undefined) {
    return { ok: false, error: readFailure("not_found", `Entity '${name}' not found in Stack`) };
  }

  const contributing = await fetchContributingDocuments(tx, [row.id]);
  return {
    ok: true,
    value: withClassificationState(
      rowToEntity(row, contributing.get(row.id) ?? []),
      pick,
      pick.matches,
    ),
  };
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
