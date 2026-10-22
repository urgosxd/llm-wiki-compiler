/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/query.ts
 * @description Query-string reading, query schemas, and the error senders.
 *
 * Split out of `routes/pages.ts` as its own unit because FastAPI's
 * last-occurrence query rule and the two envelope senders are plumbing shared by
 * both page endpoints, not part of archive assembly.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import {
  pydanticFloat,
  pydanticString,
  pydanticUuid,
} from "../../errors.js";
import type { ApiError, ValidationFailure } from "../../errors.js";

// ---------------------------------------------------------------------------
// Query-parameter reading
// ---------------------------------------------------------------------------

/**
 * Reads one raw query-string value, keeping FastAPI's last-occurrence rule.
 *
 * Express's default `simple` parser yields `string | string[]`; Starlette hands
 * the last occurrence to the parameter. A present-but-empty value stays `""`
 * rather than becoming absent, so `?min_confidence=` reports `input: ""` on the
 * `float_parsing` failure, exactly as measured.
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

/** Query schema for `GET /aks/v1/pages/{entity_name}`. */
export const EntityPageQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
});

/** Query schema for `GET /aks/v1/pages`. */
export const AllPagesQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
});

/** Keys each endpoint reads, in the order FastAPI declares them. */
export const ENTITY_PAGE_QUERY_KEYS = ["stack_id", "domain"] as const;
export const ALL_PAGES_QUERY_KEYS = ["stack_id", "domain", "min_confidence"] as const;

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
export function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
export function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

