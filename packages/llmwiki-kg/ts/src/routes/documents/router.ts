/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/router.ts
 * @description The documents router construction.
 *
 * Split out of `routes/documents.ts` as its own unit because the mount point and
 * route paths are the part callers observe.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../../auth.js";
import { withRequestTransaction, type TransactionalHandler } from "../../db.js";
import { deleteDocument } from "./delete.js";
import { getDocument } from "./get.js";
import { listDocuments } from "./list.js";
import { uploadDocument } from "./upload.js";

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface DocumentsRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: DocumentsRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the documents router.
 *
 * Paths are absolute — the router must be mounted at the application root
 * (`app.use(createDocumentsRouter())`), not under `/stacks`, because the by-id
 * routes live under `/documents`. Auth is mounted here, mirroring
 * `dependencies=[Depends(require_api_key)]` on the Python router.
 */
export function createDocumentsRouter(
  deps: DocumentsRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/documents", deps.wrap(uploadDocument));
  router.get("/stacks/:stack_id/documents", deps.wrap(listDocuments));
  router.get("/documents/:doc_id", deps.wrap(getDocument));
  router.delete("/documents/:doc_id", deps.wrap(deleteDocument));

  return router;
}
