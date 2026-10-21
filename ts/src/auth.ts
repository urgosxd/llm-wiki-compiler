import type { NextFunction, Request, RequestHandler, Response } from "express";

import { config, type Config } from "./config.js";

/**
 * Optional API key authentication.
 *
 * TypeScript mirror of `app/core/auth.py`. When AKS_API_KEY is set, clients
 * must send the raw value in an `X-API-Key` header. When it is blank, the
 * server runs in pass-through mode and every request is allowed — deliberate
 * fail-OPEN for the reference implementation, preserved as-is.
 *
 * Like the Python dependency, this middleware opts routers in individually
 * (FastAPI uses `dependencies=[Depends(require_api_key)]` per router). It is
 * never mounted globally, so unauthenticated routes such as `/health` stay
 * unauthenticated.
 */

/** Exact FastAPI `HTTPException(detail=...)` string from auth.py. */
export const INVALID_API_KEY_DETAIL =
  "Invalid or missing API key. Provide it in the X-API-Key header.";

const UNAUTHORIZED_STATUS = 401;

/** The shape every `requireApiKey` variant shares. */
export type ApiKeyMiddleware = RequestHandler;

/**
 * Express lowercases incoming header names, so the only faithful read of
 * `X-API-Key` is `x-api-key`. Header names are case-insensitive by protocol,
 * which is exactly why no case-sensitive lookup of the raw header object is
 * attempted here.
 */
function readApiKey(req: Request): string | undefined {
  const value = req.headers["x-api-key"];
  // Express types `string[]` for repeated headers; Python's `Header()`
  // collapses duplicates too, so the last value wins here and a duplicate
  // key never accidentally authenticates.
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/**
 * Builds the middleware against an explicit config. Used by tests; production
 * code uses the module-level `requireApiKey` below.
 */
export function createRequireApiKey(cfg: Config): ApiKeyMiddleware {
  return function requireApiKeyFor(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!cfg.authEnabled) {
      // Pass-through mode — server is open.
      next();
      return;
    }

    // Raw value compared by exact equality: there is no "Bearer " prefix
    // handling in the oracle, so a prefixed value is simply a wrong key.
    // Python uses `!=` (not constant-time); this stays `!==` so the behavior
    // matches the oracle rather than silently hardening it.
    if (readApiKey(req) !== cfg.AKS_API_KEY) {
      res.status(UNAUTHORIZED_STATUS).json({ detail: INVALID_API_KEY_DETAIL });
      return;
    }

    // Identity is intentionally not attached to the request: the Python
    // version exposes nothing, because there is no per-key row ownership.
    next();
  };
}

/** Middleware bound to the module-level config singleton. */
export const requireApiKey: ApiKeyMiddleware = createRequireApiKey(config);
