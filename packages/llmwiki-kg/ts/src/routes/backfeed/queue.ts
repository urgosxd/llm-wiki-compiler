/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/queue.ts
 * @description `GET /aks/v1/backfeed/queue` — list queue items.
 *
 * Split out of `routes/backfeed.ts` as its own unit because the `item_status`
 * filter has its own measured rules: `all` and any empty value disable it, while
 * any other unrecognised value is a 400 rather than a 422, and the comparison is
 * case-sensitive.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { BACKFEED_COLUMNS, QUEUE_STATUSES } from "./model.js";
import type { BackfeedRow } from "./model.js";
import { parseQueueQuery, sendApiError, sendValidationError } from "./query.js";
import { resolveStack } from "./stack.js";
import { toBackfeedItem } from "./row.js";

/**
 * `GET /aks/v1/backfeed/queue` — list queue items, defaulting to pending only.
 *
 * `item_status=all` (and any falsy value, e.g. `item_status=`) disables the
 * filter; an empty value is *not* treated as invalid, which is why the check is
 * `item_status && item_status !== "all"` in Python and `!== ""` here. Measured:
 * `?item_status=` returns every status while `?item_status=PENDING` answers 400
 * — the comparison is case-sensitive.
 */
export async function listQueue(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
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

  const itemStatus = query.itemStatus;
  const filterByStatus =
    itemStatus !== null &&
    itemStatus !== "" &&
    itemStatus !== "all";

  if (filterByStatus && !QUEUE_STATUSES.includes(itemStatus)) {
    sendApiError(res, apiError(400, "status must be pending, approved, rejected, or all"));
    return;
  }

  const statusClause = filterByStatus ? sql`and status = ${itemStatus}` : sql.empty();

  const rows = await tx.execute<BackfeedRow>(sql`
    select ${sql.raw(BACKFEED_COLUMNS)}
    from backfeed_queue
    where stack_id = ${stack.id}
    ${statusClause}
    order by created_at desc
    limit ${query.limit}
  `);

  res.json(rows.map(toBackfeedItem));
}
