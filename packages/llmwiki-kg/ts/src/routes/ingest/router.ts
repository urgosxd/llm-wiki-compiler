/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/router.ts
 * @description The ingestion router construction.
 *
 * Split out of `routes/ingest.ts` as its own unit because the mount point and
 * route path are what callers observe.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../../auth.js";
import { withRequestTransaction, type TransactionalHandler } from "../../db.js";
import { ingestDocument } from "./pipeline.js";


/** Injectable collaborators, so integration tests can bind their own pool. */
export interface IngestRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

export const DEFAULT_DEPENDENCIES: IngestRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the ingestion router.
 *
 * Declares its full path and is mounted at the application root, mirroring the
 * Python router (`APIRouter(tags=["ingestion"], ...)` with an absolute path and
 * no prefix). Auth is mounted here, as `dependencies=[Depends(require_api_key)]`
 * is in Python.
 */
export function createIngestRouter(
  deps: IngestRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/documents/:doc_id/ingest", deps.wrap(ingestDocument));

  return router;
}

