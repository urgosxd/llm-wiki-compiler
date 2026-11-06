/**
 * @file The one required-text check every category field goes through.
 *
 * Records arrive from three places — a caller's draft, a patch, and parsed YAML
 * frontmatter — so the check takes `unknown` instead of trusting a static type, and it
 * REFUSES instead of defaulting: a category whose description or inclusion criterion
 * is empty cannot answer "what is this" or "what belongs here", which is precisely what
 * S10 requires a category to answer.
 */

import { CategoryValidationError } from "./types.js";
import type { CategoryField } from "./types.js";

/**
 * Require a non-blank string, trimmed.
 *
 * @param value - Candidate value.
 * @param field - Field name reported by the error.
 * @returns The trimmed, non-empty value.
 * @throws {CategoryValidationError} When the value is absent, not a string, or blank.
 */
export function requireText(value: unknown, field: CategoryField): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CategoryValidationError(field, `category ${field} is required and must be a non-empty string`);
  }
  return value.trim();
}
