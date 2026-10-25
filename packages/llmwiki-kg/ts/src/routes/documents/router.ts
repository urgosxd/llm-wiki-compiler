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
 * (`app.use(createDocumentsRouter())`), not under `/stacks`. Auth is mounted here,
 * mirroring `dependencies=[Depends(require_api_key)]` on the Python router.
 *
 * ## Every route names its Stack, including the by-id ones
 *
 * The by-id routes used to be `/documents/:doc_id`, which was enough while a
 * document id was globally unique and RLS was inert. It stopped being enough when
 * tenancy became real: a document id alone cannot tell a policy which Stack the
 * reader belongs to, so the query returns zero rows under the application role and
 * stays correct only while the connection bypasses RLS as a superuser. Naming the
 * Stack in the path is what lets the route bind tenant context and filter.
 *
 * The old `/documents/:doc_id` paths are deliberately NOT kept as aliases. An alias
 * would be an unfiltered read reachable by anyone, which is the exact hole this
 * closes; a caller that has not been updated fails loudly with a 404 instead of
 * quietly reading across tenants.
 */
export function createDocumentsRouter(
  deps: DocumentsRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/documents", deps.wrap(uploadDocument));
  router.get("/stacks/:stack_id/documents", deps.wrap(listDocuments));
  router.get("/stacks/:stack_id/documents/:doc_id", deps.wrap(getDocument));
  router.delete("/stacks/:stack_id/documents/:doc_id", deps.wrap(deleteDocument));

  return router;
}
