/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/response.ts
 * @description Sending FastAPI-shaped error and success bodies.
 */

import type { Response } from "express";

import type { ApiError, ValidationFailure } from "../../errors.js";

// Response helpers
// ---------------------------------------------------------------------------

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
export function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
export function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

/**
 * Formats the current instant the way Pydantic serializes
 * `datetime.now(timezone.utc)`.
 *
 * Observed oracle output: `2026-10-22T03:06:14.952861Z` — `T` separator,
 * **six** fractional digits and a `Z` suffix. `Date.prototype.toISOString()`
 * emits three, so the remaining three are appended as zeros. That is not a
 * fabricated precision: a JavaScript `Date` holds milliseconds, so its
 * sub-millisecond digits genuinely are zero. Reusing the raw string throughout is
 * the same rule `db.ts` follows for stored timestamps.
 */
export function pydanticUtcNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, -1)}000Z`;
}

/**
 * True when a filter value is present and non-empty.
 *
 * Mirrors Python's truthiness tests (`if type:`, `if relationship_types:`), where
 * `""` disables the filter instead of filtering on the empty string.
 */
export function isFilterSet(value: string | null): value is string {
  return value !== null && value !== "";
}

// ---------------------------------------------------------------------------
