/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/reject.ts
 * @description `POST /aks/v1/backfeed/reject` — mark an item rejected.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { BackfeedRejectionRequest } from "../../dto.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { BACKFEED_COLUMNS } from "./model.js";
import type { BackfeedRow } from "./model.js";
import { sendApiError, sendValidationError } from "./query.js";
import { toBackfeedItem } from "./row.js";

/**
 * `POST /aks/v1/backfeed/reject` — mark an item rejected, 200.
 *
 * The `and status = 'pending'` guard means a second reject (or a reject of an
 * already-approved item) answers 404 with the combined `not found or not in
 * pending status` message, rather than 409. Rejecting never touches the
 * ontology.
 */
export async function rejectItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = BackfeedRejectionRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;

  const rows = await tx.execute<BackfeedRow>(sql`
    update backfeed_queue
    set status = 'rejected',
        reviewed_at = now(),
        reviewed_by = ${payload.reviewed_by},
        review_note = ${payload.review_note}
    where id = ${payload.item_id}
      and status = 'pending'
    returning ${sql.raw(BACKFEED_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(
      res,
      apiError(
        404,
        `Backfeed item ${payload.item_id} not found or not in pending status`,
      ),
    );
    return;
  }

  res.json(toBackfeedItem(row));
}
