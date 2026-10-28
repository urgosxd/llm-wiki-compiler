/**
 * @file packages/llmwiki-kg/ts/src/routes/stack_graph.ts
 * @description `GET /stacks/{stack_id}/graph` — the KG render payload.
 *
 * ## Why this is its own router, mounted beside `/stacks`
 *
 * `/aks/v1` is a 1:1 port of the Python reference server, and
 * `oracle/contracts/openapi.json` plus the 422 corpus pin its path set: a route
 * added there is a route the oracle does not answer, which breaks the parity the
 * port exists to prove. This endpoint has no Python counterpart at all, so it is
 * declared outside that tree.
 *
 * It is mounted at `/stacks` rather than at its own prefix because the resource
 * it reads is a Stack — `GET /stacks/{id}/graph` says what it returns, while
 * `/graph/{id}` would need the reader to already know. The mount is additive: the
 * two routers share a prefix but no path, since `GET /:stack_id` cannot match a
 * three-segment URL.
 *
 * ## The 405 contract is not reopened
 *
 * `http-contract.ts` walks `app.router.stack` and reports the methods of the
 * **first** partial match. `PUT /stacks/<uuid>/graph` therefore reports the
 * methods of the *first* mount that partially matched — this router for the
 * `/graph` path, and the stacks router for `/stacks/<uuid>`. Both keep the same
 * `Allow` value they had before this router existed, which is pinned by a test in
 * `http-contract.test.ts`.
 *
 * ## Query parameters
 *
 * Two, both narrowings of the same graph, both bounded:
 *
 * | Parameter | Default | Bounds | Effect |
 * | --- | --- | --- | --- |
 * | `min_confidence` | `0` | `[0, 1]` | drops entities below the bound |
 * | `limit` | `500` | `[1, 2000]` | caps nodes; edges follow endpoints |
 *
 * The default `limit` is not the AKS entity default of 100: a graph view is
 * unreadable past a few hundred nodes anyway, but 100 would truncate an ordinary
 * Stack and force a renderer to paginate on its first request. The upper bound
 * keeps one response from materializing an unbounded Stack in memory.
 *
 * A truncated response says so (`truncated: true`) instead of silently returning
 * a partial graph, so a caller can decide to narrow rather than misread.
 */

import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import { readStackGraph } from "../core/stack_graph.js";
import { withRequestTransaction, type Database, type TransactionalHandler } from "../db.js";
import { toFastApiValidationError } from "../errors.js";
import type { ValidationFailure } from "../errors.js";
import { readQuery } from "./aks/query-params.js";
import { parseStackId, sendApiError, sendValidationError } from "./documents/params.js";

/** Entities a response carries when the caller does not say otherwise. */
const DEFAULT_NODE_LIMIT = 500;

/**
 * Largest page this endpoint will materialize.
 *
 * A named constant rather than a literal because it is the one number that
 * bounds this endpoint's memory cost, and it is stated in the query schema's
 * error message when a caller exceeds it.
 */
const MAX_NODE_LIMIT = 2000;

/** FastAPI's inclusive lower confidence bound. */
const MIN_CONFIDENCE_FLOOR = 0;

/** FastAPI's inclusive upper confidence bound. */
const MIN_CONFIDENCE_CEILING = 1;

/**
 * Query schema for the graph endpoint.
 *
 * Every field coerces from text, because a query string is text: `limit=2` must
 * become the number `2` rather than failing as `"2"` is not a number. `z.coerce`
 * is what does that, and the bounds are inclusive on both ends, matching how the
 * AKS query parameters behave next door.
 *
 * Defaults apply only to an **absent** parameter. A present-but-empty value
 * (`?limit=`) is passed through and rejected, exactly as the AKS endpoints treat
 * `""`: silently substituting the default would hide a caller's mistake.
 */
export const StackGraphQuery = z.object({
  min_confidence: z.coerce
    .number()
    .min(MIN_CONFIDENCE_FLOOR)
    .max(MIN_CONFIDENCE_CEILING)
    .default(MIN_CONFIDENCE_FLOOR),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NODE_LIMIT)
    .default(DEFAULT_NODE_LIMIT),
});

/** The query keys this endpoint reads, in declaration order. */
const GRAPH_QUERY_KEYS = ["min_confidence", "limit"] as const;

/** Query-schema outcome, narrowed once so the handler reads no `success` flag. */
type QueryParse =
  | { readonly ok: true; readonly data: z.infer<typeof StackGraphQuery> }
  | { readonly ok: false; readonly failure: ValidationFailure };

/**
 * Reads `min_confidence` and `limit`, applying the defaults.
 *
 * Uses the AKS `readQuery` rather than reading `req.query` directly: that helper
 * collapses a repeated parameter to its last occurrence and omits absent keys so
 * `.default(...)` can fire. Two query readers in one app would disagree on
 * `?limit=1&limit=2`, and a caller has no way to tell which one it reached.
 */
function parseQuery(req: Request): QueryParse {
  const raw = readQuery(req, GRAPH_QUERY_KEYS);
  const parsed = StackGraphQuery.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, failure: toFastApiValidationError(parsed.error, "query", raw) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * `GET /stacks/{stack_id}/graph`.
 *
 * Validation runs in the order a caller can act on: the path parameter first
 * (a malformed UUID is a 422 on the path axis), then the query, then the read —
 * which is where an unknown Stack becomes a 404 raised by the resolver.
 */
async function getStackGraph(req: Request, res: Response, tx: Database): Promise<void> {
  const stackId = parseStackId(req.params["stack_id"]);
  if (!stackId.ok) {
    sendValidationError(res, stackId.failure);
    return;
  }

  const query = parseQuery(req);
  if (!query.ok) {
    sendValidationError(res, query.failure);
    return;
  }

  const result = await readStackGraph(tx, {
    stackId: stackId.value,
    minConfidence: query.data.min_confidence,
    limit: query.data.limit,
  });
  if (!result.ok) {
    sendApiError(res, result.error);
    return;
  }

  res.json(result.value);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface StackGraphRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: StackGraphRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the graph router, mounted at `/stacks`.
 *
 * Auth is on the router for the same reason it is on the stacks router: this
 * reads tenant data, and leaving it open because the sibling router guards its
 * own paths would make the guard depend on mount order.
 *
 * The path is `/:stack_id/graph`, and the single handler is wrapped in its own
 * transaction (never a transaction-owning `app.use` middleware — see `db.ts` for
 * why that cannot work on Express 5).
 */
export function createStackGraphRouter(
  deps: StackGraphRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();
  router.use(deps.apiKey);
  router.get("/:stack_id/graph", deps.wrap(getStackGraph));
  return router;
}
