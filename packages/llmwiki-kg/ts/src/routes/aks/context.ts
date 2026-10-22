/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/context.ts
 * @description `POST /aks/v1/context` — retrieval plus an LLM selection pass.
 *
 * This is the endpoint that costs money: it embeds the question, retrieves
 * candidate chunks, then asks a model which of them matter. The selection prompt
 * and its parser live here because they are the contract the model answers against.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { resolveStack } from "../../core/stack_resolver.js";
import { embedQuery } from "../../core/extraction.js";
import { complete } from "../../core/llm_clients.js";
import { retrieveRelevantChunks } from "../../core/retrieval.js";
import type { Database } from "../../db.js";
import { AKSContextRequest, AKSContextResponse } from "../../dto.js";
import type { AKSRelationshipDto } from "../../dto.js";
import {
  ENTITY_COLUMNS,
  RELATIONSHIP_COLUMNS,
  fetchContributingDocuments,
  rowToEntity,
  rowToRelationship,
  toPostgresArrayLiteral,
} from "../../core/aks_serializers.js";
import type { EntityRow } from "../../core/aks_serializers.js";
import { toFastApiValidationError } from "../../errors.js";
import { sendApiError, sendValidationError } from "./response.js";

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
export function stripCodeFence(raw: string): string {
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
export function isPlainObject(value: unknown): value is Record<string, unknown> {
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
export function parseSelection(raw: string): Selection | null {
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
export function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * Builds the entity-selection prompt, byte for byte as Python's f-string renders
 * it.
 *
 * The prompt is part of the contract even though the provider is not: it is what
 * the model reads, so any wording change changes which entities come back.
 */
export function buildSelectionPrompt(
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
/** Send the canonical empty answer, used by every early exit. */
function sendEmptyContext(
  res: Response,
  query: string,
  reasoning: string,
  traversalPath: readonly string[] = [],
): void {
  res.json(
    AKSContextResponse.parse({
      query,
      entities: [],
      relationships: [],
      traversal_path: traversalPath,
      reasoning,
      confidence: "LOW",
      source_type: "compiled",
    }),
  );
}

/** The entity catalog shown to the model: whole stack, most confident first. */
async function loadCatalog(tx: Database, stackId: string): Promise<CatalogRow[]> {
  // The model can only select names it is shown, so this cap is part of what
  // bounds the prompt.
  return tx.execute<CatalogRow>(sql`
    select name, type
    from ontology_entities
    where stack_id = ${stackId}
    order by confidence desc
    limit ${CONTEXT_CATALOG_LIMIT}
  `);
}

/** Load the entities the model selected, matched case-insensitively by name. */
async function loadSelectedEntities(
  tx: Database,
  stackId: string,
  entityNames: readonly string[],
): Promise<EntityRow[]> {
  return tx.execute<EntityRow>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stackId}
      and lower(name) = any(${toPostgresArrayLiteral(
        entityNames.map((name) => name.toLowerCase()),
      )}::text[])
  `);
}

/** Load the edges whose BOTH endpoints are in the selected set. */
async function loadInternalRelationships(
  tx: Database,
  stackId: string,
  entityIds: readonly string[],
): Promise<AKSRelationshipDto[]> {
  const rows = await tx.execute<Parameters<typeof rowToRelationship>[0]>(sql`
    select ${sql.raw(RELATIONSHIP_COLUMNS)}
    from ontology_relationships
    where stack_id = ${stackId}
      and from_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
      and to_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
  `);
  return rows.map(rowToRelationship);
}

/** Build the final answer from the selected rows and their documents. */
async function buildContextResponse(
  tx: Database,
  query: string,
  entityRows: readonly EntityRow[],
  relationships: readonly AKSRelationshipDto[],
  selection: Selection,
): Promise<unknown> {
  const entityIds = entityRows.map((row) => row.id);
  const contributing = await fetchContributingDocuments(tx, entityIds);
  return AKSContextResponse.parse({
    query,
    entities: entityRows.map((row) => rowToEntity(row, contributing.get(row.id) ?? [])),
    relationships,
    traversal_path: entityRows.map((row) => row.name),
    reasoning: selection.reasoning,
    confidence: selection.confidence,
    source_type: "compiled",
  });
}

/** Retrieval + model selection, or `null` when the request must end early. */
interface SelectionOutcome {
  readonly selection: Selection | null;
  readonly earlyReason: string | null;
  readonly earlyPath: readonly string[];
}

/** Run retrieval and ask the model which entity names are relevant. */
async function selectEntities(
  tx: Database,
  stackId: string,
  payload: { query: string; max_entities: number },
): Promise<SelectionOutcome> {
  const queryEmbedding = await embedQuery(payload.query);
  const chunks = await retrieveRelevantChunks(
    tx, stackId, payload.query, queryEmbedding, CONTEXT_CHUNK_LIMIT,
  );
  if (chunks.length === 0) {
    return { selection: null, earlyReason: "No relevant chunks found in the Stack.", earlyPath: [] };
  }

  const catalog = await loadCatalog(tx, stackId);
  if (catalog.length === 0) {
    return { selection: null, earlyReason: "Stack has no compiled entities yet.", earlyPath: [] };
  }

  const prompt = buildSelectionPrompt(
    payload.query,
    chunks.map((chunk) => chunk.content).join("\n\n---\n\n"),
    catalog.map((entry) => `- ${entry.name} (${entry.type})`).join("\n"),
    payload.max_entities,
  );
  const selection = parseSelection(await complete(prompt, 1024));
  if (selection === null) {
    return { selection: null, earlyReason: "LLM returned malformed entity selection.", earlyPath: [] };
  }
  if (selection.entityNames.length === 0) {
    return {
      selection: null,
      earlyReason: selection.reasoning === "" ? "No relevant entities identified." : selection.reasoning,
      earlyPath: [],
    };
  }
  return { selection, earlyReason: null, earlyPath: [] };
}

export async function contextQuery(req: Request, res: Response, tx: Database): Promise<void> {
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

  const outcome = await selectEntities(tx, stackId, payload);
  if (outcome.selection === null) {
    sendEmptyContext(res, payload.query, outcome.earlyReason ?? "", outcome.earlyPath);
    return;
  }
  const selection = outcome.selection;

  const entityRows = await loadSelectedEntities(tx, stackId, selection.entityNames);
  if (entityRows.length === 0) {
    sendEmptyContext(res, payload.query, selection.reasoning, selection.entityNames);
    return;
  }

  const relationships = payload.include_relationships
    ? await loadInternalRelationships(tx, stackId, entityRows.map((row) => row.id))
    : [];

  res.json(await buildContextResponse(tx, payload.query, entityRows, relationships, selection));
}

// ---------------------------------------------------------------------------
