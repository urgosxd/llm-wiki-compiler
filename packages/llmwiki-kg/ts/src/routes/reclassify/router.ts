/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/router.ts
 * @description `POST /stacks/:stackId/reclassify` — re-decide the entities and
 * relations a Stack already holds, against the CURRENT catalog and classifier.
 *
 * ## How a developer triggers it
 *
 * The route is mounted by `createIngestRouter`, so it is reachable from the running
 * server exactly where the ingest endpoint is:
 *
 * ```bash
 * # Re-decide up to 100 stale entities and 100 stale relations of one Stack.
 * curl -sS -X POST \
 *   -H "Authorization: Bearer $AKS_API_KEY" \
 *   "http://localhost:8000/stacks/3f1a6c2e-8a1b-4c5d-9e7f-0a1b2c3d4e5f/reclassify"
 *
 * # Bounded: take at most 25 of each, because a sweep touches many provider calls.
 * curl -sS -X POST \
 *   -H "Authorization: Bearer $AKS_API_KEY" \
 *   "http://localhost:8000/stacks/3f1a6c2e-8a1b-4c5d-9e7f-0a1b2c3d4e5f/reclassify?limit=25"
 * ```
 *
 * Run it after changing `stacks.type_catalog` (a new version), after changing the
 * classifier's question set (a new `CLASSIFIER_VERSION`), or to finish rows an ingest
 * left `pending`. It performs no ingestion: no chunking, no embedding, no extraction
 * call, and no new rows. It answers with counts of what it decided, and it writes one
 * `kg_classification_log` row per classification that changed.
 *
 * ## The order the request is checked in
 *
 * `422` for a malformed path parameter or an out-of-range bound, then `503` when the
 * deployment has no classifier, then `500` when it has no bounded transaction runner,
 * and only then `404` for a Stack that does not exist. A configuration defect is a
 * property of the process, not of the request, so it is answered before a caller is
 * told anything about a particular Stack.
 *
 * ## The two refusals, and why they are refusals
 *
 * - **No classifier configured** answers 503. A reclassification that decides nothing
 *   and answers 200 is indistinguishable from one that found nothing stale, which is
 *   exactly the kind of silence S43 forbids.
 * - **No bounded transaction runner** answers 500 with the ingest router's own
 *   `IngestWiringError` message. Without a runner the only transaction available is the
 *   request-scoped one, which would stay open across every classifier call (S44).
 *
 * ## What it does not do
 *
 * It never sets `verified` (S39), never inserts or deletes a row, never rewrites the
 * projection `type` or the original `predicate`, and never writes the Stack's catalog
 * (S16). Those are properties of the operation behind it, and they are pinned by tests
 * rather than asserted here.
 */

import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { ApiKeyMiddleware } from "../../auth.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { classificationRuntime } from "../ingest/classify-stage.js";
import type { ClassificationRuntime } from "../ingest/classify-stage.js";
import type { TransactionRunner } from "../ingest/pipeline.js";
import { parseStackId, queryValue, sendApiError } from "../ingest/request.js";
import { sendValidationFailure } from "../ingest/response.js";
import { IngestWiringError } from "../ingest/wiring.js";
import { reclassifyStack } from "./run.js";

/** Rows per kind one run takes when the caller names no bound. */
export const DEFAULT_RECLASSIFY_LIMIT = 100;

/** The largest bound a caller may ask for: one provider call per row, so it is capped. */
export const MAX_RECLASSIFY_LIMIT = 500;

/** What a caller sees when no classifier is configured. Spelled once, so a test can pin it. */
export const NOT_CONFIGURED_DETAIL =
  "reclassification requires a configured classifier: set TYPESAFE_API_KEY. " +
  "Refusing to report a reclassification that decided nothing (S43).";

/** `?limit=` — a positive integer, capped so one request cannot fan out without bound. */
const ReclassifyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RECLASSIFY_LIMIT).optional(),
});

/** Injectable collaborators, so a deployment and a test bind their own. */
export interface ReclassifyRouterDependencies {
  /** Router-level auth, shared with the ingest router. */
  readonly apiKey: ApiKeyMiddleware;
  /** How each step opens its short transaction; absent means the wiring is refused. */
  readonly run?: TransactionRunner;
  /** The decision runtime factory; absent falls back to the environment. */
  readonly decisions?: () => ClassificationRuntime | undefined;
}

/** What one request was validated into. */
interface ReclassifyParams {
  readonly stackId: string;
  readonly limit: number;
}

/**
 * Validates the path parameter and the optional bound, reported together as 422.
 *
 * @param req - The request.
 * @returns The validated parameters, or `undefined` when a response was already sent.
 */
function parseReclassifyRequest(req: Request, res: Response): ReclassifyParams | undefined {
  const stackId = parseStackId(req.params["stackId"]);
  const rawQuery = { limit: queryValue(req, "limit") };
  const query = ReclassifyQuery.safeParse(rawQuery);
  if (!stackId.ok || !query.success) {
    sendValidationFailure(res, [
      ...(stackId.ok ? [] : stackId.failure.body.detail),
      ...(query.success ? [] : toFastApiValidationError(query.error, "query", rawQuery).body.detail),
    ]);
    return undefined;
  }
  return { stackId: stackId.value, limit: query.data.limit ?? DEFAULT_RECLASSIFY_LIMIT };
}

/**
 * Builds the route handler.
 *
 * @param deps - Injected collaborators.
 * @returns The Express handler.
 */
export function createReclassifyHandler(deps: ReclassifyRouterDependencies): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const params = parseReclassifyRequest(req, res);
    if (params === undefined) return;
    const runtime = (deps.decisions ?? classificationRuntime)();
    if (runtime === undefined) {
      sendApiError(res, apiError(503, NOT_CONFIGURED_DETAIL));
      return;
    }
    const run = deps.run;
    if (run === undefined) {
      next(new IngestWiringError());
      return;
    }
    void reclassifyStack(run, runtime, params)
      .then((report) => {
        if (report === undefined) {
          sendApiError(res, apiError(404, `Stack ${params.stackId} not found`));
          return;
        }
        res.status(200).json(report);
      })
      .catch((error: unknown) => {
        if (!res.headersSent) next(error);
      });
  };
}

/**
 * Builds the reclassification router.
 *
 * Declares its full path for the same reason the ingest router does: it is mounted at
 * the application root, beside `createIngestRouter`, and shares its auth and its
 * transaction shape.
 *
 * @param deps - Injected collaborators.
 * @returns The router carrying the reclassification route.
 */
export function createReclassifyRouter(deps: ReclassifyRouterDependencies): Router {
  const router = Router();
  router.use(deps.apiKey);
  router.post("/stacks/:stackId/reclassify", createReclassifyHandler(deps));
  return router;
}
