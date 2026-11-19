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
 * The values `classification_state` accepts on `GET /aks/v1/entities`.
 *
 * `free` is the union of the two free states — a decision was made and no
 * canonical type was assigned — which is the sense "libre" carries in the
 * feature's specs. `pending` and `failed` are deliberately OUTSIDE it: those are
 * operational states where no decision exists yet, and calling them free would
 * report an unanswered question as an answer about the catalog.
 */
export const CLASSIFICATION_STATE_FILTERS = [
  "classified",
  "free",
  "free_no_match",
  "free_uncertain",
  "pending",
  "failed",
] as const;

/**
 * Query schema for `GET /aks/v1/entities`.
 *
 * Declaration order mirrors `list_entities`' signature; `Optional[UUID]` and
 * `Optional[str]` both default to `None`, and `min_confidence`/`limit` carry
 * their Python defaults and inclusive bounds. `classification_state` is this
 * implementation's own filter and is declared LAST, so the order in which a
 * multi-parameter 422 reports its entries is unchanged for every parameter the
 * oracle already had.
 *
 * A closed set earns a `literal_error`, which is what FastAPI answers for a
 * `Literal[...]` query parameter; an empty value (`?classification_state=`) is a
 * present-but-unparseable value and is refused the same way. `type` keeps its
 * truthiness rule (empty means "no filter") because that is what it always did.
 *
 * `accepted_only` is declared LAST for the same reason `classification_state` is:
 * it is an addition, and appending it keeps the order in which a multi-parameter 422
 * reports its entries unchanged for every parameter that came before. It is parsed
 * by the one boolean primitive the contract already uses (`verified_only` on the
 * export), so the textual forms it accepts are the same ones — and a value that
 * cannot mean either boolean is refused rather than guessed.
 */
export const EntitiesQuery = z.object({
  stackId: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  type: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
  limit: pydanticInt({ ge: 1, le: 1000 }).default(100),
  classification_state: z.enum(CLASSIFICATION_STATE_FILTERS).nullable().default(null),
  accepted_only: pydanticBoolean().default(false),
});

/**
 * Query schema for `GET /aks/v1/entities/{name}`.
 *
 * `accepted_only` is declared LAST for the reason every addition here is appended: the
 * order in which a multi-parameter 422 reports its entries stays unchanged for every
 * parameter the oracle already had. It is the same name, polarity and default as on
 * every other graph surface, and it is parsed by the contract's own boolean primitive,
 * so a value that cannot mean either boolean is refused rather than guessed.
 */
export const EntityQuery = z.object({
  stackId: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  accepted_only: pydanticBoolean().default(false),
});

/** Query schema for `GET /aks/v1/traverse`. */
export const TraverseQuery = z.object({
  // `Query(..., description=...)`: required, so a missing value is a `missing`
  // entry rather than a default.
  start: pydanticString(),
  stackId: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  max_depth: pydanticInt({ ge: 1, le: 5 }).default(2),
  relationship_types: pydanticString().nullable().default(null),
  accepted_only: pydanticBoolean().default(false),
});

/** Query schema for `GET /aks/v1/export`. */
export const ExportQuery = z.object({
  stackId: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
  verified_only: pydanticBoolean().default(false),
  entity_type: pydanticString().nullable().default(null),
  // Declared LAST, same name and same polarity (exclusion-ON) as on every other graph
  // surface — but this is the ONE surface whose DEFAULT differs, and the exception is
  // named here rather than inherited: `/aks/v1/export` is the only surface whose payload
  // is validated against a vendored contract (AKS 0.1.0, `SCHEMA.json`), and that
  // contract closes `AKSRelationship` (`:562`, `additionalProperties: false`, no
  // `properties` map), so a refused edge cannot be marked on this surface at all.
  // Returning both classes by default would therefore hand out unmarked refused edges to
  // the consumer least able to notice. The default is therefore true: a bundle holds the
  // accepted class unless the caller asks for everything.
  //
  // `false` opts into refused items, which arrive with no marker available on this
  // surface. Because the bundle envelope is ALSO closed (`SCHEMA.json:19`), no response
  // signal can announce that, so the ONLY channel is this written contract — here, in the
  // route documentation, and in the tool description.
  accepted_only: pydanticBoolean().default(true),
});

/**
 * Keys each endpoint reads, in the order FastAPI declares them.
 *
 * `stackId`, not the oracle's `stack_id`: one name for that concept across both
 * dimensions. Every other parameter keeps its snake_case wire name.
 */
export const ENTITIES_QUERY_KEYS = [
  "stackId",
  "domain",
  "type",
  "min_confidence",
  "limit",
  "classification_state",
  "accepted_only",
] as const;
export const ENTITY_QUERY_KEYS = ["stackId", "domain", "accepted_only"] as const;
export const TRAVERSE_QUERY_KEYS = [
  "start",
  "stackId",
  "domain",
  "max_depth",
  "relationship_types",
  "accepted_only",
] as const;
export const EXPORT_QUERY_KEYS = [
  "stackId",
  "domain",
  "min_confidence",
  "verified_only",
  "entity_type",
  "accepted_only",
] as const;

// ---------------------------------------------------------------------------
