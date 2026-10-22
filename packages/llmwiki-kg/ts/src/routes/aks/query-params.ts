/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/query-params.ts
 * @description Reading and validating the AKS query-string parameters.
 *
 * Express's default `simple` parser yields `string | string[]`; Starlette hands
 * the LAST occurrence to the parameter. That collapse is reproduced here, along
 * with the rule that a present-but-empty value stays `""` rather than becoming
 * absent — the oracle reports `input: ""` on the resulting parse failure.
 */

import type { Request } from "express";
import { z } from "zod";

import {
  pydanticBoolean,
  pydanticFloat,
  pydanticInt,
  pydanticString,
  pydanticUuid,
} from "../../errors.js";

// Query-parameter reading
// ---------------------------------------------------------------------------

/**
 * Reads one raw query-string value, keeping FastAPI's last-occurrence rule.
 *
 * Express's default `simple` parser yields `string | string[]`. Starlette hands
 * the *last* occurrence to the parameter, which is what this collapse reproduces
 * — measured: `?limit=1&limit=2` returns two entities, and
 * `?type=SYSTEM&type=TECHNOLOGY` returns only the TECHNOLOGY one.
 *
 * A present-but-empty value stays `""` rather than becoming absent, because the
 * oracle reports `input: ""` on the resulting parse failure (`?limit=`).
 */
export function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const last: unknown = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * Collects `keys` from the query string, omitting absent ones.
 *
 * Omitting rather than setting `undefined` is what lets each schema's
 * `.default(...)` apply, exactly as a missing FastAPI parameter takes the
 * Python default.
 */
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

/**
 * Query schema for `GET /aks/v1/entities`.
 *
 * Declaration order mirrors `list_entities`' signature; `Optional[UUID]` and
 * `Optional[str]` both default to `None`, and `min_confidence`/`limit` carry
 * their Python defaults and inclusive bounds.
 */
export const EntitiesQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  type: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
  limit: pydanticInt({ ge: 1, le: 1000 }).default(100),
});

/** Query schema for `GET /aks/v1/entities/{name}`. */
export const EntityQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
});

/** Query schema for `GET /aks/v1/traverse`. */
export const TraverseQuery = z.object({
  // `Query(..., description=...)`: required, so a missing value is a `missing`
  // entry rather than a default.
  start: pydanticString(),
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  max_depth: pydanticInt({ ge: 1, le: 5 }).default(2),
  relationship_types: pydanticString().nullable().default(null),
});

/** Query schema for `GET /aks/v1/export`. */
export const ExportQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
  verified_only: pydanticBoolean().default(false),
  entity_type: pydanticString().nullable().default(null),
});

/** Keys each endpoint reads, in the order FastAPI declares them. */
export const ENTITIES_QUERY_KEYS = ["stack_id", "domain", "type", "min_confidence", "limit"] as const;
export const ENTITY_QUERY_KEYS = ["stack_id", "domain"] as const;
export const TRAVERSE_QUERY_KEYS = ["start", "stack_id", "domain", "max_depth", "relationship_types"] as const;
export const EXPORT_QUERY_KEYS = [
  "stack_id",
  "domain",
  "min_confidence",
  "verified_only",
  "entity_type",
] as const;

// ---------------------------------------------------------------------------
