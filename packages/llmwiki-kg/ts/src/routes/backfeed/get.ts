/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/get.ts
 * @description `GET /aks/v1/backfeed/:item_id` — one item, or 404.
 *
 * ## Why this route requires a Stack
 *
 * The lookup used to be `where id = $1` and nothing else, so any caller holding
 * an item UUID could read another tenant's proposal by guessing or leaking that
 * id. `backfeed_queue` has RLS with `FORCE` and a `tenant_isolation` policy — but
 * the policy reads `app.stack_id`, and **nothing in the backfeed path sets it**.
 * Measured against the shipped database: the application role is a superuser with
 * `bypassrls = true` and owns the table, so the policy never runs at all.
 *
 * Relying on the binding would therefore have been relying on a barrier that is
 * absent in this deployment. The filter is the barrier.
 *
 * ## Why the query string, not the path
 *
 * `GET /aks/v1/backfeed/:item_id` is not an AKS spec endpoint — only `flag`,
 * `approve` and `queue` are — so extending it breaks no parity. `stack_id` and
 * `domain` come from the query string exactly as `GET /queue` already reads them,
 * which keeps one convention for the sibling endpoints instead of two.
 *
 * There is deliberately no alias that keeps the unscoped path working: an
 * unscoped read is the defect.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { BACKFEED_COLUMNS } from "./model.js";
import type { BackfeedRow } from "./model.js";
import { BackfeedItemParams, parseQueueQuery, sendApiError, sendValidationError } from "./query.js";
import { resolveStack } from "./stack.js";
import { toBackfeedItem } from "./row.js";

/**
 * `GET /aks/v1/backfeed/:item_id` — one item, or 404.
 *
 * A path failure is reported before the Stack is resolved, so a malformed id
 * still answers 422 rather than a Stack error: the path is the more specific
 * cause and the caller can fix it without touching the query string.
 */
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

  const query = parseQueueQuery(req);
  if (!query.ok) {
    sendValidationError(res, query.failure);
    return;
  }

  const stack = await resolveStack(tx, query.stackId, query.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const rows = await tx.execute<BackfeedRow>(sql`
    select ${sql.raw(BACKFEED_COLUMNS)}
    from backfeed_queue
    where id = ${params.data.item_id} and stack_id = ${stack.id}
  `);

  const row = rows[0];
  if (row === undefined) {
    // One message for "no such item" and "not in this Stack", so the endpoint
    // does not confirm the existence of an id in someone else's tenant.
    sendApiError(res, apiError(404, `Backfeed item ${params.data.item_id} not found`));
    return;
  }

  res.json(toBackfeedItem(row));
}
