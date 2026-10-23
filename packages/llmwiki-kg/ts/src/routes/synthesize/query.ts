/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/query.ts
 * @description Query-string reading and response-sending for the one-entity route.
 *
 * Split out of `routes/synthesize.ts` as its own unit because Starlette's
 * last-occurrence query rule and the two envelope senders are shared plumbing,
 * not part of either endpoint's selection logic.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import {
  pydanticString,
  pydanticUuid,
} from "../../errors.js";
import type { ApiError, ValidationFailure } from "../../errors.js";

// ---------------------------------------------------------------------------
// Query-parameter reading (the single-entity endpoint's signature)
// ---------------------------------------------------------------------------

/**
 * Reads one raw query-string value, keeping FastAPI's last-occurrence rule.
 *
 * Express's default `simple` parser yields `string | string[]`; Starlette hands
 * the last occurrence to the parameter.
 */
export function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const last: unknown = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** Collects `keys` from the query string, omitting absent ones. */
export function readQuery(req: Request, keys: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readQueryValue(req.query[key]);
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  return raw;
}

/** Query schema for `POST /aks/v1/entities/{name}/synthesize-description`. */
export const SynthesizeOneQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
});

export const SYNTHESIZE_ONE_QUERY_KEYS = ["stack_id", "domain"] as const;

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
export function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
export function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

