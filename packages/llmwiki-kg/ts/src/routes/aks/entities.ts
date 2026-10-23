/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/entities.ts
 * @description `GET /aks/v1/entities` and `GET /aks/v1/entities/{name}`.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import { sql } from "drizzle-orm";

import {
  ENTITY_COLUMNS,
  fetchContributingDocuments,
  rowToEntity,
} from "../../core/aks_serializers.js";
import { readEntities, readEntityByName, toApiError } from "../../core/graph_read.js";
import type { EntityRow } from "../../core/aks_serializers.js";
import type { Database } from "../../db.js";
import { apiError, pydanticString, toFastApiValidationError } from "../../errors.js";
import { isFilterSet, sendApiError, sendValidationError } from "./response.js";
import {
  ENTITIES_QUERY_KEYS,
  ENTITY_QUERY_KEYS,
  EntitiesQuery,
  EntityQuery,
  readQuery,
} from "./query-params.js";

// GET /aks/v1/entities
// ---------------------------------------------------------------------------

/**
 * `GET /aks/v1/entities` — entities of one Stack, most confident first.
 *
 * `order by confidence desc, name` is contractual: it is what makes `limit`
 * deterministic for callers, and the name tie-break is what keeps two equally
 * confident entities in a stable order across requests.
 */
export async function listEntities(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ENTITIES_QUERY_KEYS);
  const query = EntitiesQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const { stack_id: stackId, domain, type, min_confidence: minConfidence, limit } = query.data;

  // The query itself lives in `core/graph_read.ts` so a non-HTTP caller (the `kg`
  // dimension, MCP, a test) can read the graph without going through Express.
  const result = await readEntities(tx, {
    stackId,
    domain,
    type,
    minConfidence,
    limit,
  });
  if (!result.ok) {
    sendApiError(res, toApiError(result.error));
    return;
  }
  res.json(result.value);
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
export async function getEntity(req: Request, res: Response, tx: Database): Promise<void> {
  const rawName = readQuery(req, ENTITY_QUERY_KEYS);
  const query = EntityQuery.safeParse(rawName);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", rawName));
    return;
  }

  // A path parameter is always a string, so this parse cannot fail for a request
  // Express routed here; it exists so the value is narrowed without a cast.
  const name = EntityNameParams.parse({ name: req.params["name"] }).name;

  const result = await readEntityByName(tx, query.data.stack_id, query.data.domain, name);
  if (!result.ok) {
    sendApiError(res, toApiError(result.error));
    return;
  }
  res.json(result.value);
}

// ---------------------------------------------------------------------------
