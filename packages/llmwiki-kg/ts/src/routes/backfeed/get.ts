/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/get.ts
 * @description `GET /aks/v1/backfeed/:item_id` — one item, or 404.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { BACKFEED_COLUMNS } from "./model.js";
import type { BackfeedRow } from "./model.js";
import { BackfeedItemParams } from "./query.js";
import { sendApiError, sendValidationError } from "./query.js";
import { toBackfeedItem } from "./row.js";

/** `GET /aks/v1/backfeed/:item_id` — one item, or 404. */
export async function getItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const raw = req.params["item_id"];
  const params = BackfeedItemParams.safeParse({ item_id: raw });
  if (!params.success) {
    sendValidationError(res, toFastApiValidationError(params.error, "path", { item_id: raw }));
    return;
  }

  const rows = await tx.execute<BackfeedRow>(sql`
    select ${sql.raw(BACKFEED_COLUMNS)}
    from backfeed_queue
    where id = ${params.data.item_id}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Backfeed item ${params.data.item_id} not found`));
    return;
  }

  res.json(toBackfeedItem(row));
}
