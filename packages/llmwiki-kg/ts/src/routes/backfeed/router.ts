/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/router.ts
 * @description The `/aks/v1/backfeed` router construction.
 *
 * Split out of `routes/backfeed.ts` as its own unit because registration order is
 * the part of this module a caller can observe: `GET /queue` must be registered
 * before `GET /:item_id`, mirroring the Python decorator order, or Express parses
 * `/queue` as an item id and answers 422 instead of listing.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../../auth.js";
import { withRequestTransaction, type TransactionalHandler } from "../../db.js";
import { approveItem } from "./approve.js";
import { flagItem } from "./flag.js";
import { getItem } from "./get.js";
import { listQueue } from "./queue.js";
import { rejectItem } from "./reject.js";

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface BackfeedRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

export const DEFAULT_DEPENDENCIES: BackfeedRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/aks/v1/backfeed` router.
 *
 * Auth is mounted on the router, mirroring
 * `dependencies=[Depends(require_api_key)]`, and every handler runs through the
 * route-level transaction wrapper — never a transaction-owning `app.use`
 * middleware. `approve` relies on that: the ontology writes and the queue status
 * flip share one transaction, so a failure cannot leave absorbed entities behind
 * for an item that still reads `pending`.
 */
export function createBackfeedRouter(
  deps: BackfeedRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/flag", deps.wrap(flagItem));
  router.get("/queue", deps.wrap(listQueue));
  router.post("/approve", deps.wrap(approveItem));
  router.post("/reject", deps.wrap(rejectItem));
  // Registered last: `:item_id` would otherwise shadow the literal paths above.
  router.get("/:item_id", deps.wrap(getItem));

  return router;
}
