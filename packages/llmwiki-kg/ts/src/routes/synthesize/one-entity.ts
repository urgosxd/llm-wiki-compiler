/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/one-entity.ts
 * @description `POST /aks/v1/entities/{name}/synthesize-description`.
 *
 * Split out of `routes/synthesize.ts` as its own unit because its lookup rule —
 * exact case-insensitive name *inside the selected Stack*, so a name from
 * another Stack is a 404 — belongs to this endpoint alone.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { resolveStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { EntityNameParams, SynthesizeOneResult } from "./models.js";
import { SynthesizeOneQuery, SYNTHESIZE_ONE_QUERY_KEYS, readQuery, sendApiError, sendValidationError } from "./query.js";
import { fetchEntityNames, synthesizeOne } from "./description.js";

// ---------------------------------------------------------------------------
// POST /aks/v1/entities/{name}/synthesize-description
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the single-entity result reads it. */
export type EntityDescriptionRow = {
  readonly name: string;
  readonly description: string | null;
};

/**
 * The `{name}` path parameter.
 *
 * A path parameter is always a string, so this parse cannot fail for a request
 * Express routed here; it exists so the value is narrowed without a cast.
 */
function requireEntityName(req: Request): string {
  return EntityNameParams.parse({ name: req.params["name"] }).name;
}

/** The entity's id, found by exact case-insensitive name inside the Stack. */
async function findEntityId(
  tx: Database,
  stackId: string,
  name: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ readonly id: string }>(sql`
    select id from ontology_entities
    where stack_id = ${stackId} and lower(name) = lower(${name})
  `);
  return rows[0]?.id;
}

/** The entity's description as it now stands, re-read after the write. */
async function readDescription(tx: Database, entityId: string): Promise<EntityDescriptionRow> {
  const rows = await tx.execute<EntityDescriptionRow>(sql`
    select name, description from ontology_entities where id = ${entityId}
  `);
  const result = rows[0];
  if (result === undefined) {
    // The row was deleted between the update and this read. Python would raise
    // on `result["name"]` and answer 500; the port states it instead of
    // dereferencing a missing row.
    throw new Error("ontology_entities row disappeared during description synthesis");
  }
  return result;
}

/**
 * `POST /aks/v1/entities/{name}/synthesize-description` — backfill, one entity.
 *
 * The entity is found by exact, case-insensitive name inside the Stack, so a name
 * from a different Stack is a 404. The response is a plain dict in Python, which
 * means the field order is the literal insertion order:
 * `entity_name, description, synthesized`.
 *
 * The description is re-read **after** the write, so `description` is whatever is
 * now in the row — the freshly synthesized text, or the previous value when
 * nothing could be grounded (`synthesized: false`).
 */
export async function synthesizeOneEntity(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const raw = readQuery(req, SYNTHESIZE_ONE_QUERY_KEYS);
  const query = SynthesizeOneQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const name = requireEntityName(req);
  const entityId = await findEntityId(tx, stack.stack.id, name);
  if (entityId === undefined) {
    sendApiError(res, apiError(404, `Entity '${name}' not found in Stack`));
    return;
  }

  const allNames = await fetchEntityNames(tx, stack.stack.id);
  const wrote = await synthesizeOne(tx, stack.stack.id, entityId, allNames);
  const result = await readDescription(tx, entityId);

  res.json(
    SynthesizeOneResult.parse({
      entity_name: result.name,
      description: result.description,
      synthesized: wrote,
    }),
  );
}
