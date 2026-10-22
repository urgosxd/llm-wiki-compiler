import { sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import {
  ENTITY_COLUMNS,
  RELATIONSHIP_COLUMNS,
  fetchContributingDocuments,
  rowToEntity,
  rowToRelationship,
  toPostgresArrayLiteral,
} from "../core/aks_serializers.js";
import type { EntityRow } from "../core/aks_serializers.js";
import { embedQuery } from "../core/extraction.js";
import { complete } from "../core/llm_clients.js";
import { retrieveRelevantChunks } from "../core/retrieval.js";
import { resolveStack, type StackRow } from "../core/stack_resolver.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import {
  AKSBundle,
  AKSContextRequest,
  AKSContextResponse,
  AKSDocumentSummary,
  AKSTraverseResponse,
} from "../dto.js";
import type { AKSBundleDto, AKSRelationshipDto } from "../dto.js";
import {
  apiError,
  pydanticBoolean,
  pydanticFloat,
  pydanticInt,
  pydanticString,
  pydanticUuid,
  toFastApiValidationError,
} from "../errors.js";
import type { ApiError, ValidationFailure } from "../errors.js";

/**
 * AKS query endpoints — the TypeScript port of `app/routers/aks.py`.
 *
 * Five endpoints, all mounted under `/aks/v1`:
 *
 *   GET  /aks/v1/entities          list entities, filterable
 *   GET  /aks/v1/entities/{name}   single entity
 *   GET  /aks/v1/traverse          BFS traversal from a starting entity
 *   POST /aks/v1/context           natural-language query (hybrid retrieval + LLM)
 *   GET  /aks/v1/export            full Stack as an AKS Bundle
 *
 * Every non-obvious behaviour below was measured against the live oracle rather
 * than inferred from the Python source, and each measurement is recorded next to
 * the code that depends on it.
 *
 * ## Request order is contractual: validation, then Stack, then filters
 *
 * FastAPI resolves every declared parameter before the handler body runs, so a
 * malformed query parameter answers 422 even when the Stack does not exist.
 * `?domain=nonexistent&limit=0` is a 422 about `limit`, not a 404 about the
 * Stack. The port reproduces this by parsing the query before calling
 * {@link resolveStack}.
 *
 * Multiple failures are reported together, in the Python signature's declaration
 * order (`stack_id`, `domain`, `type`, `min_confidence`, `limit` for the list
 * endpoint), because Pydantic emits one entry per failing parameter in that
 * order. The Zod schemas below therefore declare their fields in exactly that
 * order and nothing is sorted afterwards.
 *
 * ## An empty filter value means "no filter", because Python says so
 *
 * `if type:`, `if verified_only:`, `if relationship_types:` and
 * `if entity_type:` are all *truthiness* tests, so `?type=` filters nothing while
 * `?limit=` is a 422. Measured: `GET /aks/v1/export?entity_type=` returns every
 * entity, and `GET /aks/v1/traverse?relationship_types=` follows every edge.
 * A `!== undefined` check would silently diverge on both.
 *
 * ## `?limit=5.0` and Python's numeric-literal laxness are the one known
 * ## divergence, and it is inherited from `errors.ts`
 *
 * Pydantic parses a query string into an `int` through Python's own numeric
 * grammar, so it accepts `5.0`, `05`, `+5`, `5_0` and `5_0.0`, while
 * {@link pydanticInt} accepts only `[+-]?digits`. Measured on the oracle:
 * `?limit=5.0` is 200; this port answers 422 `int_parsing`. The same applies to
 * {@link pydanticFloat} on underscores (`?min_confidence=1_0.5`). Fixing it
 * belongs in `errors.ts`, which is outside this slice's edit surface and is
 * shared with the already-merged routers (`backfeed.ts` has the identical
 * behaviour), so the divergence is reported rather than duplicated locally as a
 * second interpretation of Pydantic's grammar.
 *
 * ## Raw SQL, not the query builder
 *
 * Same reasoning as `stacks.ts` and `retrieval.ts`: the traverse endpoint needs a
 * `with recursive` CTE and the retrieval call needs pgvector operators, neither
 * of which the Drizzle builder expresses. Emitting the statements directly keeps
 * them diffable against the Python ones.
 */

// ---------------------------------------------------------------------------
// Query-parameter reading
// ---------------------------------------------------------------------------

/**
 * Reads one raw query-string value, keeping FastAPI's last-occurrence rule.
 *
 * Express's default `simple` parser yields `string | string[]`. Starlette hands
 * the *last* occurrence to the parameter, which is what this collapse reproduces
 * — measured: `?limit=1&limit=2` returns two entities, and
 * `?type=SYSTEM&type=TECHNOLOGY` returns only the TECHNOLOGY one.
 *
 * A present-but-empty value stays `""` rather than becoming absent, because the
 * oracle reports `input: ""` on the resulting parse failure (`?limit=`).
 */
function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const last: unknown = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * Collects `keys` from the query string, omitting absent ones.
 *
 * Omitting rather than setting `undefined` is what lets each schema's
 * `.default(...)` apply, exactly as a missing FastAPI parameter takes the
 * Python default.
 */
function readQuery(req: Request, keys: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readQueryValue(req.query[key]);
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  return raw;
}

/**
 * Query schema for `GET /aks/v1/entities`.
 *
 * Declaration order mirrors `list_entities`' signature; `Optional[UUID]` and
 * `Optional[str]` both default to `None`, and `min_confidence`/`limit` carry
 * their Python defaults and inclusive bounds.
 */
const EntitiesQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  type: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
  limit: pydanticInt({ ge: 1, le: 1000 }).default(100),
});

/** Query schema for `GET /aks/v1/entities/{name}`. */
const EntityQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
});

/** Query schema for `GET /aks/v1/traverse`. */
const TraverseQuery = z.object({
  // `Query(..., description=...)`: required, so a missing value is a `missing`
  // entry rather than a default.
  start: pydanticString(),
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  max_depth: pydanticInt({ ge: 1, le: 5 }).default(2),
  relationship_types: pydanticString().nullable().default(null),
});

/** Query schema for `GET /aks/v1/export`. */
const ExportQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
  verified_only: pydanticBoolean().default(false),
  entity_type: pydanticString().nullable().default(null),
});

/** Keys each endpoint reads, in the order FastAPI declares them. */
const ENTITIES_QUERY_KEYS = ["stack_id", "domain", "type", "min_confidence", "limit"] as const;
const ENTITY_QUERY_KEYS = ["stack_id", "domain"] as const;
const TRAVERSE_QUERY_KEYS = ["start", "stack_id", "domain", "max_depth", "relationship_types"] as const;
const EXPORT_QUERY_KEYS = [
  "stack_id",
  "domain",
  "min_confidence",
  "verified_only",
  "entity_type",
] as const;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

/**
 * Formats the current instant the way Pydantic serializes
 * `datetime.now(timezone.utc)`.
 *
 * Observed oracle output: `2026-10-22T03:06:14.952861Z` — `T` separator,
 * **six** fractional digits and a `Z` suffix. `Date.prototype.toISOString()`
 * emits three, so the remaining three are appended as zeros. That is not a
 * fabricated precision: a JavaScript `Date` holds milliseconds, so its
 * sub-millisecond digits genuinely are zero. Reusing the raw string throughout is
 * the same rule `db.ts` follows for stored timestamps.
 */
function pydanticUtcNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, -1)}000Z`;
}

/**
 * True when a filter value is present and non-empty.
 *
 * Mirrors Python's truthiness tests (`if type:`, `if relationship_types:`), where
 * `""` disables the filter instead of filtering on the empty string.
 */
function isFilterSet(value: string | null): value is string {
  return value !== null && value !== "";
}

// ---------------------------------------------------------------------------
// GET /aks/v1/entities
// ---------------------------------------------------------------------------

/**
 * `GET /aks/v1/entities` — entities of one Stack, most confident first.
 *
 * `order by confidence desc, name` is contractual: it is what makes `limit`
 * deterministic for callers, and the name tie-break is what keeps two equally
 * confident entities in a stable order across requests.
 */
async function listEntities(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ENTITIES_QUERY_KEYS);
  const query = EntitiesQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const { stack_id: stackId, domain, type, min_confidence: minConfidence, limit } = query.data;

  const stack = await resolveStack(tx, stackId, domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const typeClause = isFilterSet(type) ? sql`and type = ${type}` : sql.empty();

  const rows = await tx.execute<EntityRow>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stack.stack.id}
      and confidence >= ${minConfidence}
      ${typeClause}
    order by confidence desc, name
    limit ${limit}
  `);

  if (rows.length === 0) {
    res.json([]);
    return;
  }

  const contributing = await fetchContributingDocuments(
    tx,
    rows.map((row) => row.id),
  );

  res.json(
    rows.map((row) => rowToEntity(row, contributing.get(row.id) ?? [])),
  );
}

// ---------------------------------------------------------------------------
// GET /aks/v1/entities/{name}
// ---------------------------------------------------------------------------

/** Path-parameter validator for `:name`. FastAPI's `str` path param. */
const EntityNameParams = z.object({ name: pydanticString() });

/**
 * `GET /aks/v1/entities/{name}` — one entity by exact, case-insensitive name.
 *
 * The lookup is `lower(name) = lower(%s)`, so `gateway` finds `Gateway`. It is an
 * equality test on the whole name, not a prefix or trigram match — a partial name
 * is a 404, and the 404 detail echoes the *requested* text, not any row's name.
 */
async function getEntity(req: Request, res: Response, tx: Database): Promise<void> {
  const rawName = readQuery(req, ENTITY_QUERY_KEYS);
  const query = EntityQuery.safeParse(rawName);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", rawName));
    return;
  }

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  // A path parameter is always a string, so this parse cannot fail for a request
  // Express routed here; it exists so the value is narrowed without a cast.
  const name = EntityNameParams.parse({ name: req.params["name"] }).name;

  const rows = await tx.execute<EntityRow>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stack.stack.id} and lower(name) = lower(${name})
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Entity '${name}' not found in Stack`));
    return;
  }

  const contributing = await fetchContributingDocuments(tx, [row.id]);
  res.json(rowToEntity(row, contributing.get(row.id) ?? []));
}

// ---------------------------------------------------------------------------
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
async function traverse(req: Request, res: Response, tx: Database): Promise<void> {
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

  const startRows = await tx.execute<{ id: string; name: string }>(sql`
    select id, name from ontology_entities
    where stack_id = ${stack.stack.id} and lower(name) = lower(${start})
  `);

  const startRow = startRows[0];
  if (startRow === undefined) {
    sendApiError(res, apiError(404, `Entity '${start}' not found in Stack`));
    return;
  }

  // `relationship_types.split(",")` with empty segments dropped, so `","` yields
  // an empty list — which matches nothing — while an absent or empty parameter
  // disables the filter entirely. Both measured.
  const typesList = isFilterSet(relationshipTypes)
    ? relationshipTypes
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
    : null;

  const typeClause =
    typesList === null
      ? sql.empty()
      : sql`and r.type = any(${toPostgresArrayLiteral(typesList)}::text[])`;

  const rows = await tx.execute<TraverseRow>(sql`
    with recursive walk as (
      select
        ${startRow.id}::uuid as current_entity_id,
        array[${startRow.id}::uuid] as visited,
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
      where r.stack_id = ${stack.stack.id}
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
  `);

  const steps = rows.map((row) => ({
    from_entity: requireText(row.from_name, "from_name"),
    relationship: requireText(row.rel_type, "rel_type"),
    to_entity: requireText(row.to_name, "to_name"),
    depth: row.depth,
    // `real` is not null in the schema, and the anchor row is already excluded
    // above, so a null here would mean the join dropped its row.
    confidence: Number(requireNumber(row.confidence, "confidence")),
  }));

  const distinctEntities = new Set<string>([startRow.name]);
  for (const step of steps) {
    distinctEntities.add(step.from_entity);
    distinctEntities.add(step.to_entity);
  }

  res.json(
    AKSTraverseResponse.parse({
      start: startRow.name,
      max_depth: maxDepth,
      steps,
      entity_count: distinctEntities.size,
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
function requireText(value: string | null, column: string): string {
  if (value === null) {
    throw new TypeError(`traverse produced a null ${column}`);
  }
  return value;
}

/** Same contract as {@link requireText}, for the `real` confidence column. */
function requireNumber(value: number | null, column: string): number {
  if (value === null) {
    throw new TypeError(`traverse produced a null ${column}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /aks/v1/context
// ---------------------------------------------------------------------------

/** One entry of the entity catalog the prompt shows the model. */
type CatalogRow = {
  name: string;
  type: string;
};

/** Numbers of chunks requested, and of catalog rows offered, matching Python. */
const CONTEXT_CHUNK_LIMIT = 8;
const CONTEXT_CATALOG_LIMIT = 200;

/** The three confidence levels the response model allows. */
const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

/** A confidence level, after Python's `.upper()` and its fallback to `LOW`. */
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** The model's parsed selection, before it is trusted. */
interface Selection {
  readonly entityNames: string[];
  readonly reasoning: string;
  readonly confidence: ConfidenceLevel;
}

/**
 * Renders `response.choices[0].message.content` as Python would read it after
 * `json.loads`.
 *
 * The prompt asks for bare JSON, but models fence their answers anyway, so the
 * Python handler strips one ``` fence before parsing. Reproduced verbatim,
 * including the `json` tag strip: `raw.split("```")[1]` takes the text between
 * the first two fences.
 */
function stripCodeFence(raw: string): string {
  let text = raw;
  if (text.startsWith("```")) {
    text = text.split("```")[1] ?? "";
    if (text.startsWith("json")) {
      text = text.slice(4);
    }
    text = text.trim();
  }
  return text;
}

/** True when `value` is a plain JSON object, as `json.loads` would yield a dict. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the model's answer into a {@link Selection}, or `null` when the text is
 * not JSON at all.
 *
 * `null` maps to Python's `json.JSONDecodeError` branch, which answers the
 * "malformed entity selection" response rather than an error. Everything *after*
 * a successful parse stays unvalidated in Python — it indexes the dict directly —
 * so a wrong shape raises `AttributeError` and becomes a 500. That is reproduced
 * by throwing a `TypeError`, which the error handler renders as the same 500.
 */
function parseSelection(raw: string): Selection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) {
    throw new TypeError("LLM returned JSON that is not an object");
  }

  const names = parsed["entity_names"] ?? [];
  if (!Array.isArray(names)) {
    throw new TypeError("LLM returned a non-list entity_names");
  }
  const entityNames = names.map((name: unknown) => {
    if (typeof name !== "string") {
      throw new TypeError("LLM returned a non-string entity name");
    }
    return name.trim();
  });

  const reasoning = parsed["reasoning"] ?? "";
  if (typeof reasoning !== "string") {
    throw new TypeError("LLM returned a non-string reasoning");
  }

  const rawConfidence = parsed["confidence"] ?? "LOW";
  if (typeof rawConfidence !== "string") {
    throw new TypeError("LLM returned a non-string confidence");
  }
  const upper = rawConfidence.toUpperCase();
  const confidence: ConfidenceLevel = isConfidenceLevel(upper) ? upper : "LOW";

  return { entityNames, reasoning, confidence };
}

/** Narrows an uppercased string to one of the three allowed levels. */
function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * Builds the entity-selection prompt, byte for byte as Python's f-string renders
 * it.
 *
 * The prompt is part of the contract even though the provider is not: it is what
 * the model reads, so any wording change changes which entities come back.
 */
function buildSelectionPrompt(
  query: string,
  chunkText: string,
  catalogText: string,
  maxEntities: number,
): string {
  return `You are helping route a query to relevant entities in a knowledge graph.

The user's query:
${query}

The most semantically relevant passages from the source documents:
${chunkText}

The compiled entities available in this domain:
${catalogText}

Identify the entities from the catalog above that are most relevant to answering
the query. Return a JSON object with this exact shape:

{
  "entity_names": ["Name1", "Name2", ...],
  "reasoning": "Brief explanation of why these entities are relevant",
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}

Return at most ${String(maxEntities)} entity names. Use exact names from
the catalog. Confidence is HIGH when the passages clearly answer the query
through these entities, MEDIUM when partial coverage, LOW when the Stack
appears thin on this topic.

Return ONLY the JSON object, no other text.`;
}

/**
 * `POST /aks/v1/context` — natural-language query against one Stack.
 *
 * Pipeline, in Python's order:
 *
 * 1. validate the body;
 * 2. resolve the Stack (422 when neither reference is given, 404 when unknown);
 * 3. embed the query and hybrid-retrieve the top 8 chunks — no LLM;
 * 4. one LLM call that picks entity names out of the catalog;
 * 5. look those entities up by exact name, plus the relationships between them;
 * 6. return the subgraph.
 *
 * ## Three empty-answer branches, each with its own reason string
 *
 * The reason text is contractual — it is what a caller shows when nothing was
 * found — and each branch names a *different* cause:
 *
 * - no chunks -> `"No relevant chunks found in the Stack."`
 * - no catalog -> `"Stack has no compiled entities yet."`
 * - LLM returned nothing usable -> `reasoning or "No relevant entities identified."`
 *
 * The last one reuses the model's own reasoning when it gave any, which is why an
 * empty selection can still carry a real explanation.
 *
 * ## Relationships are only those *between* selected entities
 *
 * The relationship query requires **both** endpoints to be in the selection
 * (`from_entity_id = any(...) and to_entity_id = any(...)`), so an edge to a
 * neighbour outside the selection is dropped. That is what makes the response a
 * self-contained subgraph rather than a frontier.
 *
 * ## `entity_names` from the model are not trusted for lookup
 *
 * Names are lowercased and matched with `lower(name) = any(...)`, so casing
 * cannot lose a match, and a name the model invented simply matches nothing. If
 * *none* match, `traversal_path` reports the requested names and the confidence
 * drops to `LOW` — the model's own confidence is discarded on that path.
 */
async function contextQuery(req: Request, res: Response, tx: Database): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = AKSContextRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;

  const stack = await resolveStack(tx, payload.stack_id, payload.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }
  const stackId = stack.stack.id;

  const queryEmbedding = await embedQuery(payload.query);

  const chunks = await retrieveRelevantChunks(
    tx,
    stackId,
    payload.query,
    queryEmbedding,
    CONTEXT_CHUNK_LIMIT,
  );

  if (chunks.length === 0) {
    res.json(
      AKSContextResponse.parse({
        query: payload.query,
        entities: [],
        relationships: [],
        traversal_path: [],
        reasoning: "No relevant chunks found in the Stack.",
        confidence: "LOW",
        source_type: "compiled",
      }),
    );
    return;
  }

  // The catalog is the whole entity list, most confident first, capped at 200:
  // the model can only select names it is shown, so this cap is part of what
  // bounds the prompt.
  const catalog = await tx.execute<CatalogRow>(sql`
    select name, type
    from ontology_entities
    where stack_id = ${stackId}
    order by confidence desc
    limit ${CONTEXT_CATALOG_LIMIT}
  `);

  if (catalog.length === 0) {
    res.json(
      AKSContextResponse.parse({
        query: payload.query,
        entities: [],
        relationships: [],
        traversal_path: [],
        reasoning: "Stack has no compiled entities yet.",
        confidence: "LOW",
        source_type: "compiled",
      }),
    );
    return;
  }

  const chunkText = chunks.map((chunk) => chunk.content).join("\n\n---\n\n");
  const catalogText = catalog.map((entry) => `- ${entry.name} (${entry.type})`).join("\n");

  const prompt = buildSelectionPrompt(
    payload.query,
    chunkText,
    catalogText,
    payload.max_entities,
  );

  const selection = parseSelection(await complete(prompt, 1024));

  if (selection === null) {
    res.json(
      AKSContextResponse.parse({
        query: payload.query,
        entities: [],
        relationships: [],
        traversal_path: [],
        reasoning: "LLM returned malformed entity selection.",
        confidence: "LOW",
        source_type: "compiled",
      }),
    );
    return;
  }

  if (selection.entityNames.length === 0) {
    res.json(
      AKSContextResponse.parse({
        query: payload.query,
        entities: [],
        relationships: [],
        traversal_path: [],
        reasoning: selection.reasoning === "" ? "No relevant entities identified." : selection.reasoning,
        confidence: "LOW",
        source_type: "compiled",
      }),
    );
    return;
  }

  const entityRows = await tx.execute<EntityRow>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stackId}
      and lower(name) = any(${toPostgresArrayLiteral(
        selection.entityNames.map((name) => name.toLowerCase()),
      )}::text[])
  `);

  if (entityRows.length === 0) {
    res.json(
      AKSContextResponse.parse({
        query: payload.query,
        entities: [],
        relationships: [],
        traversal_path: selection.entityNames,
        reasoning: selection.reasoning,
        confidence: "LOW",
        source_type: "compiled",
      }),
    );
    return;
  }

  const entityIds = entityRows.map((row) => row.id);

  let relationships: AKSRelationshipDto[] = [];
  if (payload.include_relationships) {
    const relationshipRows = await tx.execute<Parameters<typeof rowToRelationship>[0]>(sql`
      select ${sql.raw(RELATIONSHIP_COLUMNS)}
      from ontology_relationships
      where stack_id = ${stackId}
        and from_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
        and to_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
    `);
    relationships = relationshipRows.map(rowToRelationship);
  }

  const contributing = await fetchContributingDocuments(tx, entityIds);

  res.json(
    AKSContextResponse.parse({
      query: payload.query,
      entities: entityRows.map((row) => rowToEntity(row, contributing.get(row.id) ?? [])),
      relationships,
      traversal_path: entityRows.map((row) => row.name),
      reasoning: selection.reasoning,
      confidence: selection.confidence,
      source_type: "compiled",
    }),
  );
}

// ---------------------------------------------------------------------------
// GET /aks/v1/export
// ---------------------------------------------------------------------------

/** One `stack_documents` row as the bundle export reads it. */
type BundleDocumentRow = {
  id: string;
  filename: string;
  ingested_at: string;
  source_hash: string;
  truncated: boolean;
  original_length: number | null;
  audit: unknown;
};

/**
 * `GET /aks/v1/export` — the whole Stack as an AKS Bundle.
 *
 * The bundle is assembled from four reads: entities (filtered), the relationships
 * whose **both** endpoints survived that filter, every document in the Stack, and
 * the contributing-document map for the surviving entities.
 *
 * Two details that look like bugs and are not:
 *
 * 1. **`document_count` is not affected by entity filters.** Documents are listed
 *    per Stack, not per selected entity, so `?min_confidence=1` on a Stack with no
 *    confident entities still reports `document_count: 1`. Measured.
 * 2. **Relationships are filtered by endpoint survival, twice.** An edge is kept
 *    only when *both* ends are in the filtered entity set, so a high
 *    `min_confidence` cannot leak a low-confidence neighbour through an edge.
 *    The entity query is skipped entirely when no entities survive, which is why
 *    `relationship_count` is 0 rather than an error.
 *
 * `compiled_at` is the request time, never a stored value: a bundle describes the
 * graph as it was when it was produced.
 */
async function exportBundle(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, EXPORT_QUERY_KEYS);
  const query = ExportQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const {
    stack_id: stackId,
    domain,
    min_confidence: minConfidence,
    verified_only: verifiedOnly,
    entity_type: entityType,
  } = query.data;

  const resolved = await resolveStack(tx, stackId, domain);
  if (!resolved.ok) {
    sendApiError(res, resolved.error);
    return;
  }
  const stack: StackRow = resolved.stack;

  const verifiedClause = verifiedOnly ? sql`and verified = true` : sql.empty();
  const typeClause = isFilterSet(entityType) ? sql`and type = ${entityType}` : sql.empty();

  const entityRows = await tx.execute<EntityRow>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stack.id}
      and confidence >= ${minConfidence}
      ${verifiedClause}
      ${typeClause}
  `);

  const entityIds = entityRows.map((row) => row.id);

  const relationshipRows =
    entityIds.length === 0
      ? []
      : await tx.execute<Parameters<typeof rowToRelationship>[0]>(sql`
          select ${sql.raw(RELATIONSHIP_COLUMNS)}
          from ontology_relationships
          where stack_id = ${stack.id}
            and from_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
            and to_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
        `);

  const documentRows = await tx.execute<BundleDocumentRow>(sql`
    select distinct sd.id, sd.filename, sd.ingested_at,
           sd.source_hash, sd.truncated, sd.original_length, sd.audit
    from stack_documents sd
    where sd.stack_id = ${stack.id}
    order by sd.ingested_at desc
  `);

  const contributing = await fetchContributingDocuments(tx, entityIds);

  const bundle: AKSBundleDto = {
    aks_version: "0.2.0",
    domain: stack.domain,
    stack_id: stack.id,
    stack_name: stack.name,
    compiled_at: pydanticUtcNow(),
    scope: stack.scope,
    entity_count: entityRows.length,
    relationship_count: relationshipRows.length,
    document_count: documentRows.length,
    compilation_strategy: stack.compilation_strategy,
    documents: documentRows.map((row) => AKSDocumentSummary.parse(row)),
    entities: entityRows.map((row) => rowToEntity(row, contributing.get(row.id) ?? [])),
    relationships: relationshipRows.map(rowToRelationship),
  };

  res.json(AKSBundle.parse(bundle));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface AksRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: AksRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/aks/v1` router.
 *
 * Mounted at `/aks/v1`, mirroring `APIRouter(prefix="/aks/v1", ...)`. Auth is on
 * the router, as `dependencies=[Depends(require_api_key)]` is in Python, so all
 * five endpoints are guarded while `/health` stays open.
 *
 * Registration order follows the Python decorator order. In particular
 * `/entities` is registered before `/entities/:name`; Express would still match
 * them correctly either way (one has no trailing segment), but keeping the order
 * means the 405 `Allow` walk in `http-contract.ts` sees the same layer sequence
 * Starlette does.
 */
export function createAksRouter(deps: AksRouterDependencies = DEFAULT_DEPENDENCIES): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.get("/entities", deps.wrap(listEntities));
  router.get("/entities/:name", deps.wrap(getEntity));
  router.get("/traverse", deps.wrap(traverse));
  router.post("/context", deps.wrap(contextQuery));
  router.get("/export", deps.wrap(exportBundle));

  return router;
}
