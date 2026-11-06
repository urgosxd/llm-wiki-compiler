/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/router.ts
 * @description The ingestion router construction, and the transaction contract it
 * gives the pipeline.
 *
 * Split out of `routes/ingest.ts` as its own unit because the mount point, the
 * route path and the bounded-transaction decision are what callers observe.
 *
 * ## Why the router owns the transaction boundaries
 *
 * The pipeline needs TWO boundaries — one before the classifier is asked and one
 * after — because no transaction may be open while an external decision service is
 * being called (S44). It therefore asks for a {@link TransactionRunner}, and this
 * module supplies one:
 *
 * - in production, `withTransaction`, the process-wide pool's runner, so every
 *   stage boundary is a real COMMIT;
 * - in a test that injects its own `run`, `createTransactionRunner(database)` over
 *   the fixture pool, which is the same contract over a different handle (not
 *   imported here: the caller builds it, which is what makes the handle injectable).
 *
 * ## The one wiring that must never be silent
 *
 * A caller that injects only `wrap` gets a request-scoped transaction, which is open
 * for the whole handler. That is fine for a pipeline with no external decision call
 * in the middle, and it is NOT fine once classification is enabled: the classifier
 * would run inside an open transaction while the response told nobody. So that
 * combination is REFUSED with {@link IngestWiringError} rather than degraded
 * quietly, and a test pins the refusal. A caller that injects `wrap` and no
 * classifier keeps the old single-transaction shape, which is what the existing
 * route suites do.
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "../../auth.js";
import { withRequestTransaction, withTransaction } from "../../db.js";
import type { Database, TransactionalHandler, TransactionRunner } from "../../db.js";
import { classificationRuntime } from "./classify-stage.js";
import type { ClassificationRuntime } from "./classify-stage.js";
import { ingestDocument } from "./pipeline.js";
import { createClassificationLogRouter } from "../classification-log/router.js";
import { createReclassifyRouter } from "../reclassify/router.js";
import { IngestWiringError } from "./wiring.js";

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface IngestRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
  /**
   * How the pipeline opens each bounded transaction.
   *
   * Defaults to the process-wide runner. A caller that supplies it gets the
   * production transaction shape with its own database handle.
   */
  readonly run?: TransactionRunner;
  /**
   * The decision runtime factory, or `undefined` when classification is disabled.
   *
   * Defaults to {@link classificationRuntime}, which builds the one client from
   * configuration and reports "not configured" when no credential is present.
   */
  readonly decisions?: () => ClassificationRuntime | undefined;
}

export const DEFAULT_DEPENDENCIES: IngestRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
  run: withTransaction,
};

export { IngestWiringError, MISSING_RUNNER_MESSAGE } from "./wiring.js";

/** A runner that runs every stage in the transaction the caller already opened. */
function inlineRunner(tx: Database): TransactionRunner {
  return (work) => work(tx);
}

/**
 * Builds the handler, choosing the transaction shape from the injected
 * dependencies.
 *
 * @param deps - Router dependencies.
 * @returns The Express handler for the ingest route.
 */
function createIngestHandler(deps: IngestRouterDependencies): RequestHandler {
  const runner = deps.run;
  const decisions = deps.decisions;
  return (req, res, next) => {
    const runtime = (decisions ?? classificationRuntime)();
    if (runner === undefined) {
      // Refused, not degraded: see the module comment.
      if (runtime !== undefined) {
        next(new IngestWiringError());
        return;
      }
      deps.wrap((rq, rs, tx) => ingestDocument(rq, rs, inlineRunner(tx)))(req, res, next);
      return;
    }
    void ingestDocument(req, res, runner, runtime).catch((error: unknown) => {
      // A handler that already sent a response cannot be re-reported.
      if (!res.headersSent) next(error);
    });
  };
}

/**
 * Builds the ingestion router.
 *
 * Declares its full path and is mounted at the application root, mirroring the
 * Python router (`APIRouter(tags=["ingestion"], ...)` with an absolute path and
 * no prefix). Auth is mounted here, as `dependencies=[Depends(require_api_key)]`
 * is in Python.
 *
 * ## Reclassification rides on the same router, on purpose
 *
 * `POST /stacks/:stackId/reclassify` re-decides rows this pipeline already wrote, so it
 * needs exactly the same two collaborators: the Stack's auth and a bounded transaction
 * runner. Mounting it here is what makes it reachable from the running application
 * without a second mount point, a second auth surface or a new service — and it is why
 * an unconfigured classifier is refused the same way on both endpoints.
 *
 * ## Classification-log retention rides here too, for the same reason
 *
 * `POST /stacks/:stackId/classification-log/prune` bounds the failure history this
 * pipeline appends. It needs the same auth and the same bounded runner, but it is an
 * ADMINISTRATIVE operation rather than part of ingest: nothing in this pipeline calls
 * it, and mounting it beside its sibling is what keeps one auth surface instead of two.
 *
 * @param deps - Injected collaborators; defaults to the process-wide ones.
 * @returns The router carrying the ingest, reclassification and retention routes.
 */
export function createIngestRouter(
  deps: IngestRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stackId/documents/:doc_id/ingest", createIngestHandler(deps));
  router.use(
    createReclassifyRouter({
      apiKey: deps.apiKey,
      // `exactOptionalPropertyTypes` distinguishes an absent runner from an undefined
      // one, and the reclassification handler refuses the absent case rather than
      // silently running inside the request transaction.
      ...(deps.run === undefined ? {} : { run: deps.run }),
      ...(deps.decisions === undefined ? {} : { decisions: deps.decisions }),
    }),
  );
  router.use(
    createClassificationLogRouter({
      apiKey: deps.apiKey,
      // Same `exactOptionalPropertyTypes` treatment as above: an absent runner is
      // passed as absent, so the retention handler can refuse it explicitly.
      ...(deps.run === undefined ? {} : { run: deps.run }),
    }),
  );

  return router;
}
