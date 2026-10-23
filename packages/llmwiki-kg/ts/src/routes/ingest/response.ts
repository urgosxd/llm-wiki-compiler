/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/response.ts
 * @description Sending this endpoint's error bodies.
 *
 * Lives apart from the router so the pipeline can send a validation failure
 * without importing the router, which would close an import cycle
 * (`router` -> `pipeline` -> `router`).
 */

import type { Response } from "express";

import type { ValidationFailure } from "../../errors.js";

/** Sends a combined `RequestValidationError` body: `{"detail": [...]}`. */
export function sendValidationFailure(
  res: Response,
  detail: ValidationFailure["body"]["detail"],
): void {
  res.status(422).json({ detail });
}
