/**
 * @file packages/llmwiki-kg/ts/src/routes/aks.ts
 * @description The `/aks/v1` query surface — public router entry point.
 *
 * The router was split into `src/routes/aks/` to keep each file under the
 * project's size limits. This module stays the single import site:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Query-parameter reading | `aks/query-params.ts` |
 * | Error/response bodies | `aks/response.ts` |
 * | `/entities`, `/entities/{name}` | `aks/entities.ts` |
 * | `/traverse` | `aks/traverse.ts` |
 * | `/context` | `aks/context.ts` |
 * | `/export` | `aks/export.ts` |
 *
 * Statements are emitted directly rather than through the Drizzle builder: the
 * traverse endpoint needs a `with recursive` CTE and retrieval needs pgvector
 * operators, neither of which the builder expresses. Emitting them keeps them
 * diffable against the Python ones.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import { withRequestTransaction, type TransactionalHandler } from "../db.js";
import { getEntity, listEntities } from "./aks/entities.js";
import { contextQuery } from "./aks/context.js";
import { exportBundle } from "./aks/export.js";
import { traverse } from "./aks/traverse.js";

// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface AksRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: AksRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/aks/v1` router.
 *
 * Mounted at `/aks/v1`, mirroring `APIRouter(prefix="/aks/v1", ...)`. Auth is on
 * the router, as `dependencies=[Depends(require_api_key)]` is in Python, so all
 * five endpoints are guarded while `/health` stays open.
 *
 * Registration order follows the Python decorator order. In particular
 * `/entities` is registered before `/entities/:name`; Express would still match
 * them correctly either way (one has no trailing segment), but keeping the order
 * means the 405 `Allow` walk in `http-contract.ts` sees the same layer sequence
 * Starlette does.
 */
export function createAksRouter(deps: AksRouterDependencies = DEFAULT_DEPENDENCIES): Router {
  const router = Router();
  router.use(deps.apiKey);
  router.get("/entities", deps.wrap(listEntities));
  router.get("/entities/:name", deps.wrap(getEntity));
  router.get("/traverse", deps.wrap(traverse));
  router.post("/context", deps.wrap(contextQuery));
  router.get("/export", deps.wrap(exportBundle));
  return router;
}
