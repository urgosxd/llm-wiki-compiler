/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/one-page.ts
 * @description `GET /aks/v1/pages/{entity_name}`.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { getOrGeneratePage } from "../../core/page_generator.js";
import { resolveStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { AKSEntityPage } from "../../dto.js";
import { apiError, pydanticString, toFastApiValidationError } from "../../errors.js";
import { EntityPageQuery, ENTITY_PAGE_QUERY_KEYS, readQuery, sendApiError, sendValidationError } from "./query.js";

/** Path-parameter validator for `:entity_name`. FastAPI's `str` path param. */
export const EntityNameParams = z.object({ entity_name: pydanticString() });

// GET /aks/v1/pages/{entity_name}
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the name lookup reads it. */
export type EntityIdRow = { readonly id: string };

/**
 * `GET /aks/v1/pages/{entity_name}` — one page, generated or cached.
 *
 * The entity is resolved **within the Stack** by exact, case-insensitive name
 * (`lower(name) = lower(%s)`), so `?domain=x` and a name from another Stack is a
 * 404 rather than a cross-Stack read. The 404 echoes the requested text.
 *
 * `get_or_generate_page` returning nothing means the row disappeared between the
 * lookup and the read; Python answers `500` with
 * `"Failed to generate entity page"` and this port emits the same JSON body.
 */
export async function getEntityPage(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ENTITY_PAGE_QUERY_KEYS);
  const query = EntityPageQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  // A path parameter is always a string, so this parse cannot fail for a request
  // Express routed here; it exists so the value is narrowed without a cast.
  const entityName = EntityNameParams.parse({ entity_name: req.params["entity_name"] })
    .entity_name;

  const rows = await tx.execute<EntityIdRow>(sql`
    select id from ontology_entities
    where stack_id = ${stack.stack.id} and lower(name) = lower(${entityName})
  `);
  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Entity '${entityName}' not found in Stack`));
    return;
  }

  const page = await getOrGeneratePage(tx, row.id);
  if (page === null) {
    sendApiError(res, apiError(500, "Failed to generate entity page"));
    return;
  }

  res.json(AKSEntityPage.parse(page));
}

