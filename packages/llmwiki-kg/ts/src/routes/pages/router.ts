/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/router.ts
 * @description The `/aks/v1/pages` router construction.
 *
 * Split out of `routes/pages.ts` as its own unit because the mount point and the
 * registration order are what the 405 `Allow` walk observes.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../../auth.js";
import { withRequestTransaction, type TransactionalHandler } from "../../db.js";
import { getAllPages } from "./all-pages.js";
import { getEntityPage } from "./one-page.js";

// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface PagesRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: PagesRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/aks/v1/pages` router.
 *
 * Mounted at `/aks/v1/pages`, mirroring `APIRouter(prefix="/aks/v1/pages", ...)`,
 * with auth on the router as `dependencies=[Depends(require_api_key)]` is in
 * Python.
 *
 * Registration order follows the Python decorator order: the parameterised
 * `/:entity_name` route is declared first and the bare `""` route second. That is
 * harmless here (the two paths differ in segment count) but it keeps the 405
 * `Allow` walk in `http-contract.ts` visiting layers in the same order Starlette
 * does.
 */
export function createPagesRouter(
  deps: PagesRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.get("/:entity_name", deps.wrap(getEntityPage));
  router.get("/", deps.wrap(getAllPages));

  return router;
}
