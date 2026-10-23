/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/query.ts
 * @description Query-string validation and the response-encoding senders.
 *
 * Split out of `routes/backfeed.ts` as its own unit because FastAPI's
 * last-occurrence query rule, the `get /queue` parameter order, and the two
 * envelope senders are shared plumbing rather than review-loop logic.
 *
 * `item_status` is validated in the handler, not by the DTO: Python types it
 * `Optional[str]` and compares in the body, so an invalid value is a 400
 * `{"detail": "<string>"}`, not a 422. Measured on the oracle:
 * `?item_status=bogus` answers 400 while a bad `stack_id` on the same request
 * answers 422 — and the query-parameter 422s are produced *before* the handler
 * runs, so `?stack_id=nope&item_status=bogus` reports the UUID error first.
 */

import type { Request, Response } from "express";
import { z } from "zod";

import { pydanticInt, pydanticString, pydanticUuid, toFastApiValidationError } from "../../errors.js";
import type { ApiError, ValidationFailure } from "../../errors.js";

/**
 * Path-parameter validator for `:item_id`.
 *
 * An object keyed by the FastAPI parameter name, like `StackIdParams` in
 * `stacks.ts`: `toFastApiValidationError` derives the `loc` tail from the Zod
 * issue path, so a bare primitive would report `loc: ["path"]` instead of
 * `loc: ["path", "item_id"]`.
 */
export const BackfeedItemParams = z.object({ item_id: pydanticUuid() });

/**
 * Query-parameter validator for `GET /queue`.
 *
 * Declaration order is the Python signature's order — `stack_id`, `domain`,
 * `item_status`, `limit` — because Pydantic reports one entry per failing
 * parameter in that order and `toFastApiValidationError` preserves Zod's issue
 * order. Measured: `?stack_id=nope&limit=0` answers the `uuid_parsing` entry
 * first, then the `greater_than_equal` entry.
 *
 * `item_status` carries its `"pending"` default here so the handler sees the
 * same value the oracle's default supplies, but its *value* set is checked in
 * the handler (400, not 422).
 */
export const QueueQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  item_status: pydanticString().nullable().default("pending"),
  limit: pydanticInt({ ge: 1, le: 200 }).default(50),
});

/** Result of a successful query parse. */
export type QueueQueryParse =
  | {
      readonly ok: true;
      readonly stackId: string | null;
      readonly domain: string | null;
      readonly itemStatus: string | null;
      readonly limit: number;
    }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
export function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
export function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

/**
 * Reads one raw query-string value.
 *
 * Express's default `simple` query parser yields `string | string[]`. FastAPI
 * keeps the **last** occurrence of a repeated parameter, which is what this
 * collapse reproduces — measured: `?limit=1&limit=200` returns 200 rows worth of
 * results, and `?limit=200&limit=1` returns one.
 */
export function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const last: unknown = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * Collects the four query parameters into a plain object, omitting absent ones.
 *
 * Absent keys are omitted rather than set to `undefined` so the schema's
 * `.default(...)` values apply. A param present with an empty value (`?limit=`)
 * stays present as `""`, which is what the oracle reports as `input: ""` on an
 * `int_parsing` failure.
 */
export function readQueueQuery(req: Request): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of ["stack_id", "domain", "item_status", "limit"] as const) {
    const value = readQueryValue(req.query[key]);
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  return raw;
}

/** Validates the query string the way FastAPI's dependency injection does. */
export function parseQueueQuery(req: Request): QueueQueryParse {
  const raw = readQueueQuery(req);
  const parsed = QueueQuery.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, failure: toFastApiValidationError(parsed.error, "query", raw) };
  }
  return {
    ok: true,
    stackId: parsed.data.stack_id,
    domain: parsed.data.domain,
    itemStatus: parsed.data.item_status,
    limit: parsed.data.limit,
  };
}
