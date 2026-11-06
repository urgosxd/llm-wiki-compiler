/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/router.ts
 * @description `POST /stacks/:stackId/classification-log/prune` — the explicit
 * administrative retention operation for `kg_classification_log` failure events.
 *
 * ## What it is for
 *
 * A failing classifier appends one `provider_failure_preserved:*` row per sweep per
 * affected candidate, and that per-occurrence record is a diagnostic signal that must
 * not be deduped at write time. The table still has to stay bounded, so bounding it is
 * a separate, deliberate, operator-initiated call. This route is that call and nothing
 * else: **it is the explicit administrative retention operation, and it never runs
 * during ingest** — no ingest, reclassification or sweep calls it, and it opens its own
 * short transaction rather than joining one.
 *
 * ## How an operator runs it
 *
 * The route is mounted by `createIngestRouter`, beside `POST /stacks/:stackId/reclassify`,
 * so it is reachable wherever the ingest endpoint is, and it is authenticated by the same
 * `X-API-Key` header those endpoints use — the raw `AKS_API_KEY` value, which the auth
 * middleware compares by exact equality with no prefix handling, so a prefixed value is
 * simply the wrong key.
 *
 * ```bash
 * # 1. ALWAYS dry-run first: report what the window matches and delete nothing.
 * curl -sS -X POST \
 *   -H "X-API-Key: $AKS_API_KEY" \
 *   "http://localhost:8000/stacks/3f1a6c2e-8a1b-4c5d-9e7f-0a1b2c3d4e5f/classification-log/prune"
 *
 * # 2. Delete only after checking that count, and only for one Stack.
 * curl -sS -X POST \
 *   -H "X-API-Key: $AKS_API_KEY" \
 *   "http://localhost:8000/stacks/3f1a6c2e-8a1b-4c5d-9e7f-0a1b2c3d4e5f/classification-log/prune?confirm=true&retentionDays=45"
 * ```
 *
 * The success body carries exactly five keys, in this order:
 *
 * ```json
 * { "dryRun": true, "retentionDays": 30, "cutoff": "2024-05-01T09:00:00.123456Z",
 *   "matchedCount": 47, "deletedCount": 0 }
 * ```
 *
 * - `dryRun` — `true` when nothing was deleted. It is `false` only for a confirmed call.
 * - `retentionDays` — the window actually applied, so the report is readable on its own.
 * - `cutoff` — the fixed instant the window was measured against; rows older than it and
 *   of the failure family are the eligible set.
 * - `matchedCount` — how many rows the window matched, deleted or not.
 * - `deletedCount` — how many were actually deleted: always `0` on a dry run.
 *
 * ## The query contract
 *
 * - `retentionDays` — optional positive integer in `[1, 3650]`, default `30` (the named
 *   `DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS`). Out of range, zero, fractional or
 *   non-numeric answers 422.
 * - `confirm` — optional, default `false`. **Only the literal `true` deletes**: `true`
 *   and `false` are the only accepted spellings, every other value answers 422. The lax
 *   Pydantic-style boolean this package uses elsewhere (`synthesize_descriptions` on
 *   ingest) is deliberately not used here: it also reads `1`, `0`, `on`, `yes`, `t` and
 *   `y`, and a coerced truthy string is not a confirmation to delete stored rows.
 *
 * ## Status codes
 *
 * - `200` — the report, whether it deleted rows or only counted them.
 * - `422` — a malformed `:stackId` or query parameter, in the same `{"detail": [...]}`
 *   array shape the sibling ingest routers answer with. Nothing is deleted.
 * - `401` — the router-level `X-API-Key` check, shared with the ingest router.
 * - `500` — the deployment has no bounded transaction runner, refused with the ingest
 *   router's own `IngestWiringError` rather than degraded quietly.
 *
 * There is no `404`: this is a bounded operation over a set, not a lookup, so a Stack
 * that holds no eligible rows — including one that does not exist — reports zero.
 *
 * ## What it does not do
 *
 * It never touches classification state, evidence, entities, relations or any other
 * table, it never writes a summary row, and it never archives the events it removes.
 * Every surviving row is still one real occurrence. Those are properties of the
 * operation behind the route, and they are pinned by tests rather than asserted here.
 */

import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { ApiKeyMiddleware } from "../../auth.js";
import { toFastApiValidationError } from "../../errors.js";
import type { PydanticErrorDetail } from "../../errors.js";
import type { TransactionRunner } from "../ingest/pipeline.js";
import { parseStackId, queryValue } from "../ingest/request.js";
import { sendValidationFailure } from "../ingest/response.js";
import { IngestWiringError } from "../ingest/wiring.js";
import {
  DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS,
  MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS,
  pruneClassificationFailures,
} from "./prune.js";
import type { ClassificationFailurePruneOutcome } from "./prune.js";

/**
 * The only two spellings `?confirm=` accepts.
 *
 * An explicit pair rather than a coerced boolean: `"false"` is a non-empty string, so a
 * coercing boolean would read it as `true` and delete. Deletion therefore requires the
 * literal `"true"`, and every other value — `yes`, `1`, an empty string — is a 422.
 */
const CONFIRM_VALUES = ["true", "false"] as const;

/**
 * The query contract, validated the way the sibling routers validate theirs.
 *
 * `retentionDays` mirrors `ReclassifyQuery`'s bound exactly (`coerce` + `int` + `min` +
 * `max`), so one HTTP vocabulary covers both endpoints.
 */
const PruneQuery = z.object({
  retentionDays: z
    .coerce.number()
    .int()
    .min(1)
    .max(MAX_CLASSIFICATION_FAILURE_RETENTION_DAYS)
    .optional(),
  confirm: z.enum(CONFIRM_VALUES).optional(),
});

/** Injectable collaborators, so a deployment and a test bind their own. */
export interface ClassificationLogRouterDependencies {
  /** Router-level auth, shared with the ingest and reclassification routers. */
  readonly apiKey: ApiKeyMiddleware;
  /** How the prune opens its short transaction; absent means the wiring is refused. */
  readonly run?: TransactionRunner;
}

/** What one request was validated into. */
interface PruneRequest {
  readonly stackId: string;
  readonly retentionDays: number;
  /** True only when the caller spelled `confirm=true`; this is what deletion requires. */
  readonly confirm: boolean;
}

/**
 * Validates the path parameter and both query parameters, reported together as 422.
 *
 * The order is `stackId`, then the query entries in declaration order, which is the
 * order FastAPI reports them in.
 *
 * @param req - The request.
 * @param res - The response, so a failure can be sent from here.
 * @returns The validated request, or `undefined` when a 422 was already sent.
 */
function parsePruneRequest(req: Request, res: Response): PruneRequest | undefined {
  const stackId = parseStackId(req.params["stackId"]);
  const rawQuery = {
    retentionDays: queryValue(req, "retentionDays"),
    confirm: queryValue(req, "confirm"),
  };
  const query = PruneQuery.safeParse(rawQuery);
  if (!stackId.ok || !query.success) {
    sendValidationFailure(res, [
      ...(stackId.ok ? [] : stackId.failure.body.detail),
      ...(query.success ? [] : toFastApiValidationError(query.error, "query", rawQuery).body.detail),
    ]);
    return undefined;
  }
  return {
    stackId: stackId.value,
    retentionDays: query.data.retentionDays ?? DEFAULT_CLASSIFICATION_FAILURE_RETENTION_DAYS,
    confirm: query.data.confirm === "true",
  };
}

/**
 * The `422` entry for a window the storage layer refused after validation.
 *
 * The storage function re-checks the window because it is a public API of its own, so
 * its `RangeError` has to reach the caller as the same `{"detail": [...]}` array a
 * malformed query produces — one status code, one envelope, whichever layer noticed.
 * The entry is Pydantic's shape for a value a validator rejected: `value_error` under
 * the parameter's own `loc`, with the offending raw value echoed back.
 *
 * @param error - The refusal, whose message names the bound.
 * @param rawValue - The query value exactly as received.
 */
function windowFailure(error: RangeError, rawValue: unknown): PydanticErrorDetail {
  return {
    type: "value_error",
    loc: ["query", "retentionDays"],
    msg: `Value error, ${error.message}`,
    input: rawValue,
  };
}

/**
 * Maps the operation's report onto the exactly-five-key wire body.
 *
 * Written out key by key instead of forwarding the object as received, so a field
 * added to the operation later cannot silently become part of the HTTP contract, and so
 * the JSON key order T3 documents is fixed here rather than by construction order.
 *
 * @param outcome - What the operation measured and deleted.
 * @returns The response body.
 */
function responseBody(outcome: ClassificationFailurePruneOutcome) {
  return {
    dryRun: outcome.dryRun,
    retentionDays: outcome.retentionDays,
    cutoff: outcome.cutoff,
    matchedCount: outcome.matchedCount,
    deletedCount: outcome.deletedCount,
  };
}

/**
 * Builds the route handler: parse, delegate, map.
 *
 * @param deps - Injected collaborators.
 * @returns The Express handler.
 */
export function createClassificationLogPruneHandler(
  deps: ClassificationLogRouterDependencies,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const params = parsePruneRequest(req, res);
    if (params === undefined) return;
    const run = deps.run;
    if (run === undefined) {
      next(new IngestWiringError());
      return;
    }
    // `params.confirm` is already `true` only for the literal `confirm=true`, so a
    // request that did not ask for the deletion cannot reach the storage layer with one.
    void pruneClassificationFailures(run, params)
      .then((outcome) => {
        res.status(200).json(responseBody(outcome));
      })
      .catch((error: unknown) => {
        if (res.headersSent) return;
        if (error instanceof RangeError) {
          sendValidationFailure(res, [windowFailure(error, queryValue(req, "retentionDays"))]);
          return;
        }
        next(error);
      });
  };
}

/**
 * Builds the classification-log retention router.
 *
 * Declares its full absolute path for the same reason the ingest and reclassification
 * routers do: it is mounted at the application root, carries its own auth, and owns no
 * prefix of its own.
 *
 * @param deps - Injected collaborators.
 * @returns The router carrying the retention route.
 */
export function createClassificationLogRouter(
  deps: ClassificationLogRouterDependencies,
): Router {
  const router = Router();
  router.use(deps.apiKey);
  router.post("/stacks/:stackId/classification-log/prune", createClassificationLogPruneHandler(deps));
  return router;
}
