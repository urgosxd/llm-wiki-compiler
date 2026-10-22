import { z } from "zod";

import {
  pydanticBoolean,
  pydanticDict,
  pydanticFloat,
  pydanticInt,
  pydanticString,
  pydanticUuid,
} from "./errors.js";

/**
 * Request and response DTOs — the TypeScript mirror of `app/models/api.py`.
 *
 * One schema stands in for what each Pydantic model gives FastAPI three times
 * over: validating a request body, serializing a response, and describing both
 * in OpenAPI.
 *
 * ## Field names are snake_case verbatim
 *
 * `app/models/api.py` declares no aliases and no alias generator, so the JSON
 * keys are the Python attribute names exactly. Nothing is camelCased here, and
 * no `.transform` renames keys.
 *
 * ## Declaration order is load-bearing
 *
 * Every schema repeats the field order of the Python class. FastAPI reports
 * validation failures in declaration order, and `toFastApiValidationError`
 * preserves Zod's issue order rather than sorting, so this ordering is what
 * keeps multi-field 422 responses byte-identical to the oracle. Reordering a
 * field here is a contract change, not a style choice.
 *
 * ## Unknown fields are stripped, not rejected
 *
 * Zod objects strip unknown keys by default, which is what Pydantic does by
 * default too. The oracle answers `201` for a body carrying an unexpected
 * `bogus` key (recorded as `unknown_field` in the validation corpus). Do **not**
 * add `.strict()` / `.passthrough()`.
 *
 * ## Timestamps are `string`, never `Date`
 *
 * Every `datetime` field is validated as a string. `Date` stores milliseconds
 * while Postgres `timestamptz` and Pydantic carry microseconds, so parsing into
 * `Date` and formatting back would silently drop the last three digits and
 * mismatch the oracle on almost every row. See `db.ts`, `schema.ts` and
 * `odd/findings/timestamp-precision.md`.
 *
 * All `datetime` fields in the Python models are response-only, so a plain
 * string is the whole contract; there is no request body that parses a date.
 *
 * ## Required-nullable versus optional
 *
 * Two shapes that look alike in Python are not alike, and are kept apart here:
 *
 * - `Optional[X]` with **no** default is *required but nullable*: a missing key
 *   fails, an explicit `null` passes. Written as `X.nullable()`.
 * - `Optional[X] = None` is *optional*: both a missing key and `null` pass.
 *   Written as `X.nullable().default(null)`.
 *
 * This is reproduced by the primitives in `errors.ts` emitting `missing` for an
 * absent key, plus `.nullable()` at the call site for `null`.
 *
 * ## Mutable defaults
 *
 * Pydantic's `= {}` and `= []` are evaluated per instance, so every model gets
 * its own container. Zod's `.default()` stores whatever value it is handed, so a
 * literal `{}` or `[]` would be shared across every parse. All such fields use
 * `.default(() => ({}))` / `.default(() => [])` instead; `dto.test.ts` pins this
 * behaviour.
 */

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * A `datetime` field, carried as its wire string.
 *
 * Deliberately **not** `z.iso.datetime()` or `z.coerce.date()`. The server never
 * has to parse a timestamp out of a request, and the only correctness risk here
 * is losing microseconds — which any date parse would do. `db.ts` already
 * normalizes Postgres text into the exact string Pydantic emits.
 */
const Timestamp = pydanticString();

/** `dict` with Pydantic's `= {}` default, fresh per parse. */
const JsonDictDefault = pydanticDict().default(() => ({}));

// ============================================================
// Stack models (Group 1, extended with synthesize_descriptions in Group 5b)
// ============================================================

/** `Literal["stack", "workspace", "domain"]` — `StackCreate.scope`. */
export const STACK_SCOPES = ["stack", "workspace", "domain"] as const;

/** `Literal["incremental", "global"]` — compilation strategy. */
export const COMPILATION_STRATEGIES = ["incremental", "global"] as const;

/** Request body for `POST /stacks`. */
export const StackCreate = z.object({
  // Field(..., min_length=1, max_length=200) — both bounds are contractual.
  name: pydanticString({ minLength: 1, maxLength: 200 }),
  // Field(..., pattern=r"^[a-z0-9-]+$") — lowercase hyphenated slug.
  domain: pydanticString({
    pattern: { regex: /^[a-z0-9-]+$/, source: "^[a-z0-9-]+$" },
  }),
  description: pydanticString().nullable().default(null),
  scope: z.literal(STACK_SCOPES).default("stack"),
  compilation_strategy: z.literal(COMPILATION_STRATEGIES).default("incremental"),
  synthesize_descriptions: pydanticBoolean().default(false),
});

/** Request body for `PATCH /stacks/{id}`. Every field is optional. */
export const StackUpdate = z.object({
  // Optional[str] = Field(None, min_length=1, max_length=200): the bounds apply
  // to a supplied string, and `null` is accepted as "leave unchanged".
  name: pydanticString({ minLength: 1, maxLength: 200 }).nullable().default(null),
  description: pydanticString().nullable().default(null),
  scope: z.literal(STACK_SCOPES).nullable().default(null),
  compilation_strategy: z.literal(COMPILATION_STRATEGIES).nullable().default(null),
  synthesize_descriptions: pydanticBoolean().nullable().default(null),
});

/**
 * Response shape for all Stack endpoints. Mirrors the `stacks` table.
 *
 * `description` is `Optional[str]` with no default, so it is required and
 * nullable: the oracle always emits the key, with `null` when absent.
 */
export const StackResponse = z.object({
  id: pydanticUuid(),
  name: pydanticString(),
  domain: pydanticString(),
  description: pydanticString().nullable(),
  scope: pydanticString(),
  compilation_strategy: pydanticString(),
  synthesize_descriptions: pydanticBoolean(),
  created_at: Timestamp,
  updated_at: Timestamp,
});

// ============================================================
// Document models (Group 2)
// ============================================================

/** `content_type` and `original_length` are required-nullable, like `StackResponse.description`. */
export const DocumentResponse = z.object({
  id: pydanticUuid(),
  stack_id: pydanticUuid(),
  filename: pydanticString(),
  size_bytes: pydanticInt(),
  content_type: pydanticString().nullable(),
  source_hash: pydanticString(),
  truncated: pydanticBoolean(),
  original_length: pydanticInt().nullable(),
  ingested_at: Timestamp,
  audit: pydanticDict().nullable().default(null),
});

// ============================================================
// AKS endpoint models (Group 4)
// ============================================================

/** Traceability block on every entity and relationship. */
export const AKSSource = z.object({
  document_id: pydanticUuid().nullable().default(null),
  connector_id: pydanticUuid().nullable().default(null),
  source_kind: pydanticString().nullable().default(null),
  extracted_at: Timestamp.nullable().default(null),
  model: pydanticString().nullable().default(null),
  verified: pydanticBoolean().default(false),
  pipeline: pydanticString().nullable().default(null),
});

/** An entity as it appears in AKS Bundle exports and query responses. */
export const AKSEntity = z.object({
  id: pydanticUuid(),
  name: pydanticString(),
  type: pydanticString(),
  description: pydanticString().nullable().default(null),
  properties: JsonDictDefault,
  confidence: pydanticFloat(),
  contributing_documents: z.array(pydanticUuid()).default(() => []),
  last_seen_at: Timestamp.nullable().default(null),
  source: AKSSource,
});

/** A relationship as it appears in AKS Bundle exports and query responses. */
export const AKSRelationship = z.object({
  id: pydanticUuid(),
  from_entity_id: pydanticUuid(),
  to_entity_id: pydanticUuid(),
  type: pydanticString(),
  description: pydanticString().nullable().default(null),
  confidence: pydanticFloat(),
  source: AKSSource,
});

/** Request body for `POST /aks/v1/context`. */
export const AKSContextRequest = z.object({
  // Field(..., min_length=1): an empty query is a 422, not a 400.
  query: pydanticString({ minLength: 1 }),
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  // Field(default=8, ge=1, le=50) — the bounds are inclusive on both ends.
  max_entities: pydanticInt({ ge: 1, le: 50 }).default(8),
  include_relationships: pydanticBoolean().default(true),
});

/** `Literal["HIGH", "MEDIUM", "LOW"]`. */
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

/** `Literal["compiled", "live", "hybrid"]`. */
export const SOURCE_TYPES = ["compiled", "live", "hybrid"] as const;

/** Response from `POST /aks/v1/context`. */
export const AKSContextResponse = z.object({
  query: pydanticString(),
  entities: z.array(AKSEntity),
  relationships: z.array(AKSRelationship),
  traversal_path: z.array(pydanticString()),
  reasoning: pydanticString(),
  confidence: z.literal(CONFIDENCE_LEVELS),
  source_type: z.literal(SOURCE_TYPES).default("compiled"),
});

/** One step in a traversal result. */
export const AKSTraverseStep = z.object({
  from_entity: pydanticString(),
  relationship: pydanticString(),
  to_entity: pydanticString(),
  depth: pydanticInt(),
  confidence: pydanticFloat(),
});

/** Response from `GET /aks/v1/traverse`. */
export const AKSTraverseResponse = z.object({
  start: pydanticString(),
  max_depth: pydanticInt(),
  steps: z.array(AKSTraverseStep),
  entity_count: pydanticInt(),
});

/**
 * `AKSDocument` as it appears in a Bundle export.
 *
 * Note this is *not* `DocumentResponse`: it has no `content_type`, no
 * `stack_id`, and a nullable `original_length`, and it mirrors
 * `AKSDocumentSummary` in the Python file rather than the `documents` table.
 */
export const AKSDocumentSummary = z.object({
  id: pydanticUuid(),
  filename: pydanticString(),
  ingested_at: Timestamp,
  source_hash: pydanticString(),
  truncated: pydanticBoolean(),
  original_length: pydanticInt().nullable().default(null),
  audit: pydanticDict().nullable().default(null),
});

/** The full AKS Bundle export shape. */
export const AKSBundle = z.object({
  aks_version: pydanticString().default("0.2.0"),
  domain: pydanticString(),
  stack_id: pydanticUuid(),
  stack_name: pydanticString(),
  compiled_at: Timestamp,
  scope: pydanticString(),
  entity_count: pydanticInt(),
  relationship_count: pydanticInt(),
  document_count: pydanticInt().default(0),
  compilation_strategy: pydanticString().nullable().default(null),
  documents: z.array(AKSDocumentSummary).default(() => []),
  entities: z.array(AKSEntity).default(() => []),
  relationships: z.array(AKSRelationship).default(() => []),
});

// ============================================================
// Entity page models (Group 5)
// ============================================================

/** A single generated entity page. */
export const AKSEntityPage = z.object({
  entity_name: pydanticString(),
  markdown: pydanticString(),
  generated_at: Timestamp,
  source_entity_id: pydanticUuid(),
  graph_version: pydanticString(),
  source_type: pydanticString().default("compiled"),
  cached: pydanticBoolean().nullable().default(null),
});

// ============================================================
// Backfeed models (Group 6)
// ============================================================

/** `Literal["run", "direct"]` — `BackfeedFlagRequest.origin`. */
export const BACKFEED_ORIGINS = ["run", "direct"] as const;

/** `Literal["manual", "auto", "api"]` — `BackfeedFlagRequest.trigger_type`. */
export const BACKFEED_TRIGGER_TYPES = ["manual", "auto", "api"] as const;

/** A proposed entity inside a backfeed item. */
export const BackfeedEntityProposal = z.object({
  name: pydanticString(),
  type: pydanticString(),
  description: pydanticString().nullable().default(null),
  // Field(default=0.7, ge=0.0, le=1.0) — a probability, so the bounds are real.
  confidence: pydanticFloat({ ge: 0, le: 1 }).default(0.7),
  properties: JsonDictDefault,
});

/**
 * A proposed relationship inside a backfeed item.
 *
 * The keys are `from_entity` / `to_entity`, **not** the `from` / `to` used by
 * the `backfeed_queue.proposal` JSONB comment in `schema.ts`. The API model is
 * the contract here.
 */
export const BackfeedRelationshipProposal = z.object({
  from_entity: pydanticString(),
  to_entity: pydanticString(),
  type: pydanticString(),
  description: pydanticString().nullable().default(null),
  confidence: pydanticFloat({ ge: 0, le: 1 }).default(0.7),
});

/** The structured payload of a backfeed item. */
export const BackfeedProposal = z.object({
  entities: z.array(BackfeedEntityProposal).default(() => []),
  relationships: z.array(BackfeedRelationshipProposal).default(() => []),
});

/** Request body for `POST /aks/v1/backfeed/flag`. */
export const BackfeedFlagRequest = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  origin: z.literal(BACKFEED_ORIGINS).default("direct"),
  trigger_type: z.literal(BACKFEED_TRIGGER_TYPES).default("manual"),
  // Required: no default, so a missing `proposal` is a `missing` 422 entry.
  proposal: BackfeedProposal,
  note: pydanticString().nullable().default(null),
  metadata: JsonDictDefault,
});

/**
 * A backfeed queue item as returned by the API.
 *
 * `note`, `reviewed_at`, `reviewed_by` and `review_note` are `Optional[...]` with
 * no default, so they are required-nullable: the response always contains the
 * key, `null` when the item has not been reviewed.
 */
export const BackfeedItemResponse = z.object({
  id: pydanticUuid(),
  stack_id: pydanticUuid(),
  origin: pydanticString(),
  trigger_type: pydanticString(),
  proposal: BackfeedProposal,
  note: pydanticString().nullable(),
  metadata: pydanticDict(),
  status: pydanticString(),
  reviewed_at: Timestamp.nullable(),
  reviewed_by: pydanticString().nullable(),
  review_note: pydanticString().nullable(),
  created_at: Timestamp,
});

/** Request body for `POST /aks/v1/backfeed/approve`. */
export const BackfeedApprovalRequest = z.object({
  item_id: pydanticUuid(),
  reviewed_by: pydanticString().nullable().default(null),
  review_note: pydanticString().nullable().default(null),
});

/** Result of approving a backfeed item. */
export const BackfeedApprovalResult = z.object({
  item_id: pydanticUuid(),
  entities_absorbed: pydanticInt(),
  relationships_absorbed: pydanticInt(),
  /** Always `"approved"` on success. */
  status: pydanticString(),
});

/** Request body for `POST /aks/v1/backfeed/reject`. */
export const BackfeedRejectionRequest = z.object({
  item_id: pydanticUuid(),
  reviewed_by: pydanticString().nullable().default(null),
  review_note: pydanticString().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/**
 * Structural types for each schema, derived with `z.infer` so they cannot drift
 * from the schemas above. Exported under a `Dto` suffix because the schema
 * constants already occupy the Pydantic class names.
 */
export type StackCreateDto = z.infer<typeof StackCreate>;
export type StackUpdateDto = z.infer<typeof StackUpdate>;
export type StackResponseDto = z.infer<typeof StackResponse>;
export type DocumentResponseDto = z.infer<typeof DocumentResponse>;
export type AKSSourceDto = z.infer<typeof AKSSource>;
export type AKSEntityDto = z.infer<typeof AKSEntity>;
export type AKSRelationshipDto = z.infer<typeof AKSRelationship>;
export type AKSContextRequestDto = z.infer<typeof AKSContextRequest>;
export type AKSContextResponseDto = z.infer<typeof AKSContextResponse>;
export type AKSTraverseStepDto = z.infer<typeof AKSTraverseStep>;
export type AKSTraverseResponseDto = z.infer<typeof AKSTraverseResponse>;
export type AKSDocumentSummaryDto = z.infer<typeof AKSDocumentSummary>;
export type AKSBundleDto = z.infer<typeof AKSBundle>;
export type AKSEntityPageDto = z.infer<typeof AKSEntityPage>;
export type BackfeedEntityProposalDto = z.infer<typeof BackfeedEntityProposal>;
export type BackfeedRelationshipProposalDto = z.infer<typeof BackfeedRelationshipProposal>;
export type BackfeedProposalDto = z.infer<typeof BackfeedProposal>;
export type BackfeedFlagRequestDto = z.infer<typeof BackfeedFlagRequest>;
export type BackfeedItemResponseDto = z.infer<typeof BackfeedItemResponse>;
export type BackfeedApprovalRequestDto = z.infer<typeof BackfeedApprovalRequest>;
export type BackfeedApprovalResultDto = z.infer<typeof BackfeedApprovalResult>;
export type BackfeedRejectionRequestDto = z.infer<typeof BackfeedRejectionRequest>;
