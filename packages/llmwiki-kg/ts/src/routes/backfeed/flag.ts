/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/flag.ts
 * @description `POST /aks/v1/backfeed/flag` — queue a proposal for review.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { BackfeedFlagRequest } from "../../dto.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { BACKFEED_COLUMNS } from "./model.js";
import type { BackfeedRow } from "./model.js";
import { sendApiError, sendValidationError } from "./query.js";
import { resolveStack } from "./stack.js";
import { toBackfeedItem } from "./row.js";

/** The validated flag payload. */
type FlagPayload = ReturnType<typeof BackfeedFlagRequest.parse>;

/**
 * Inserts the pending queue item and returns the row as Postgres stored it.
 *
 * The two `jsonb` arguments are serialized to text: postgres-js cannot bind a JS
 * object as a `jsonb` parameter (it throws ERR_INVALID_ARG_TYPE), while a JSON
 * string is accepted and cast by Postgres. The explicit `::jsonb` makes that cast
 * part of the statement rather than an inference.
 */
async function insertQueueItem(
  tx: Database,
  stackId: string,
  payload: FlagPayload,
): Promise<BackfeedRow> {
  const rows = await tx.execute<BackfeedRow>(sql`
    insert into backfeed_queue (
      stack_id, origin, trigger_type, proposal,
      note, metadata, status
    )
    values (${stackId}, ${payload.origin}, ${payload.trigger_type},
            ${JSON.stringify(payload.proposal)}::jsonb, ${payload.note},
            ${JSON.stringify(payload.metadata)}::jsonb, 'pending')
    returning ${sql.raw(BACKFEED_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into backfeed_queue returned no row");
  }
  return row;
}

/**
 * `POST /aks/v1/backfeed/flag` — queue a proposal for review, 201.
 *
 * Validation order is contractual and measured:
 *
 * 1. body shape (Pydantic) -> 422 array;
 * 2. empty proposal -> **400**, and it comes *before* the Stack lookup
 *    (measured: `{"proposal": {}}` with no stack answers 400, not 422);
 * 3. Stack resolution -> 422 or 404.
 *
 * Nothing is written to the ontology here: the item is stored `pending` and
 * stays that way until approved.
 */
export async function flagItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = BackfeedFlagRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;
  if (payload.proposal.entities.length === 0 && payload.proposal.relationships.length === 0) {
    sendApiError(res, apiError(400, "Proposal must include at least one entity or relationship"));
    return;
  }

  const stack = await resolveStack(tx, payload.stack_id, payload.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const row = await insertQueueItem(tx, stack.id, payload);
  res.status(201).json(toBackfeedItem(row));
}