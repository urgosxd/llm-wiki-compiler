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
import { checkProposalAgainstOntology, loadStackOntology } from "./ontology-gate.js";
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
 * 3. Stack resolution -> 422 or 404;
 * 4. ontology -> **422**, using the same refusal `/approve` produces.
 *
 * Nothing is written to the ontology here: the item is stored `pending` and
 * stays that way until approved.
 *
 * ## Why the ontology is checked here as well as at approval
 *
 * It used to be checked only at approval, which made `201 Created` a lie: the
 * queue accepted an item that could never be approved. A caller learned their
 * type was undeclared only after a human had spent attention reviewing it, and
 * the rejection then arrived from a different endpoint than the one that said the
 * proposal was fine.
 *
 * Checking here is symmetric and cheap: the same `checkProposalAgainstOntology`
 * decides both, so the two endpoints cannot disagree. `loadStackOntology` reads
 * the column in this transaction, so both see the same declaration.
 *
 * **What this gives up.** A type that is not declared can no longer be queued as
 * a proposal. That is the deliberate trade: the queue is a review surface for
 * work that is viable, not an inbox for vocabulary changes. Proposing a new type
 * is a change to the Stack's declaration, which is `PATCH /stacks` against the
 * column that already holds it.
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

  // Refuse before writing: an item that cannot be approved must not occupy the
  // queue, and the caller must hear it from the endpoint that accepted the call.
  const ontology = await loadStackOntology(tx, stack.id);
  const refusal = checkProposalAgainstOntology(ontology, payload.proposal);
  if (refusal !== undefined) {
    res.status(refusal.status).json(refusal.body);
    return;
  }

  const row = await insertQueueItem(tx, stack.id, payload);
  res.status(201).json(toBackfeedItem(row));
}