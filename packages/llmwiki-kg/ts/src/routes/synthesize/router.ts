/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/router.ts
 * @description The synthesis router construction.
 *
 * Split out of `routes/synthesize.ts` as its own unit because the mount point and
 * the registration order are the part of this module the 405 `Allow` walk
 * observes, and they are easier to audit on their own.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../../auth.js";
import { withRequestTransaction, type TransactionalHandler } from "../../db.js";
import { backfillStack } from "./backfill.js";
import { synthesizeOneEntity } from "./one-entity.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface SynthesizeRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: SynthesizeRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the synthesis router.
 *
 * Mounted at `/` with no path argument, because `synthesize.py` puts the full
 * path on each route (`/stacks/...` and `/aks/v1/...`). Prefixing the mount would
 * move both endpoints and break the 405 `Allow` walk.
 *
 * Registration order follows the Python decorator order: the Stack backfill
 * first, the single-entity route second.
 */
export function createSynthesizeRouter(
  deps: SynthesizeRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/synthesize-descriptions", deps.wrap(backfillStack));
  router.post(
    "/aks/v1/entities/:name/synthesize-description",
    deps.wrap(synthesizeOneEntity),
  );

  return router;
}
