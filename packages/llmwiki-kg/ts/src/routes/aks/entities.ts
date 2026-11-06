/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/entities.ts
 * @description `GET /aks/v1/entities` and `GET /aks/v1/entities/{name}`.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import { readEntities, readEntityByName, toApiError } from "../../core/graph_read.js";
import type { Database } from "../../db.js";
import { pydanticString, toFastApiValidationError } from "../../errors.js";
import { sendApiError, sendValidationError } from "./response.js";
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
 *
 * Two filters narrow the answer, and they mean different things:
 *
 * - `type` names a CANONICAL catalog type, so it returns only items the catalog
 *   classified that way (plus rows with no recorded decision, whose label always
 *   answered this filter). A free entity whose extractor proposal happens to read
 *   `Role` is not a `Role` and is not returned.
 * - `classification_state` asks for the classification states themselves, so a
 *   caller can list what is free, or what is still pending, and read the reason
 *   from each entity's `properties.kg_classification` block.
 *
 * With neither filter the answer holds both kinds: a free entity is an ordinary
 * graph member, not a quarantine.
 */
export async function listEntities(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ENTITIES_QUERY_KEYS);
  const query = EntitiesQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const {
    stackId,
    domain,
    type,
    min_confidence: minConfidence,
    limit,
    classification_state: classificationState,
  } = query.data;

  // The query itself lives in `core/graph_read.ts` so a non-HTTP caller (the `kg`
  // dimension, MCP, a test) can read the graph without going through Express.
  const result = await readEntities(tx, {
    stackId,
    domain,
    type,
    minConfidence,
    limit,
    classificationState,
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
 *
 * Homonyms are legal since the identity migration, so the answer is the row the
 * documented total order picks (a classified row first, then the most confident,
 * then by id) and `properties.kg_classification.name_matches` reports how many rows
 * shared the name. The endpoint never silently guesses between them.
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

  const result = await readEntityByName(tx, query.data.stackId, query.data.domain, name);
  if (!result.ok) {
    sendApiError(res, toApiError(result.error));
    return;
  }
  res.json(result.value);
}

// ---------------------------------------------------------------------------
