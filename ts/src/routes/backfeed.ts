import { sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import { consolidateBackfeedProposal } from "../core/consolidation.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import {
  BackfeedApprovalRequest,
  BackfeedApprovalResult,
  BackfeedFlagRequest,
  BackfeedItemResponse,
  BackfeedProposal,
  BackfeedRejectionRequest,
} from "../dto.js";
import type {
  BackfeedApprovalResultDto,
  BackfeedItemResponseDto,
  BackfeedProposalDto,
} from "../dto.js";
import { apiError, pydanticInt, pydanticString, pydanticUuid, toFastApiValidationError } from "../errors.js";
import type { ApiError, ValidationFailure } from "../errors.js";

/**
 * `/aks/v1/backfeed` router — the TypeScript port of `app/routers/backfeed.py`.
 *
 * Five endpoints reproducing the human-review loop: flag an item, list the
 * queue, read one item, approve it (absorbing the proposal into the ontology) or
 * reject it. Nothing here calls an LLM — the reasoning already happened before
 * the item reached the queue.
 *
 * Every non-obvious behaviour below is a measurement against the live oracle,
 * named where it lives.
 *
 * ## Row shape and key order are contractual
 *
 * {@link BACKFEED_COLUMNS} repeats the column list from the Python module
 * verbatim, in order. The JSON key order of every response comes from
 * `BackfeedItemResponse`'s declaration order, exactly like Python's
 * `BackfeedItemResponse(**row)`: the row is handed to the Zod schema, which both
 * validates and fixes the order. Postgres `jsonb` does **not** preserve object
 * key order (it stores keys sorted by length then bytes), so re-parsing the
 * proposal through `BackfeedProposal` is what keeps the nested entity objects in
 * the oracle's order.
 *
 * ## Route order matters
 *
 * `GET /queue` is registered before `GET /:item_id`, mirroring the Python
 * decorator order. Express matches in registration order, so reversing them
 * would make `/queue` parse as an item id and answer 422 instead of listing.
 *
 * ## `item_status` is validated in the handler, not by the DTO
 *
 * Python types it `Optional[str]` and compares in the body, so an invalid value
 * is a 400 `{"detail": "<string>"}`, not a 422. Measured on the oracle:
 * `?item_status=bogus` answers 400 while a bad `stack_id` on the same request
 * answers 422 — and the query-parameter 422s are produced *before* the handler
 * runs, so `?stack_id=nope&item_status=bogus` reports the UUID error first.
 */

/** Oracle column list, in oracle order. Mirrors the Python `select`. */
const BACKFEED_COLUMNS =
  "id, stack_id, origin, trigger_type, proposal, note, metadata, status, reviewed_at, reviewed_by, review_note, created_at";

/** The statuses `item_status` accepts besides `all`. */
const QUEUE_STATUSES: readonly string[] = ["pending", "approved", "rejected"];

/** A `backfeed_queue` row as selected by {@link BACKFEED_COLUMNS}. */
type BackfeedRow = {
  readonly id: string;
  readonly stack_id: string;
  readonly origin: string;
  readonly trigger_type: string;
  /** `jsonb`; postgres-js hands back a parsed value, validated on the way out. */
  readonly proposal: unknown;
  readonly note: string | null;
  /** `jsonb`; nullable in SQL even though the API always writes an object. */
  readonly metadata: unknown;
  readonly status: string;
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
  readonly review_note: string | null;
  readonly created_at: string;
};

/**
 * Path-parameter validator for `:item_id`.
 *
 * An object keyed by the FastAPI parameter name, like `StackIdParams` in
 * `stacks.ts`: `toFastApiValidationError` derives the `loc` tail from the Zod
 * issue path, so a bare primitive would report `loc: ["path"]` instead of
 * `loc: ["path", "item_id"]`.
 */
const BackfeedItemParams = z.object({ item_id: pydanticUuid() });

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
const QueueQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  item_status: pydanticString().nullable().default("pending"),
  limit: pydanticInt({ ge: 1, le: 200 }).default(50),
});

/** Result of a successful query parse. */
type QueueQueryParse =
  | {
      readonly ok: true;
      readonly stackId: string | null;
      readonly domain: string | null;
      readonly itemStatus: string | null;
      readonly limit: number;
    }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
function sendValidationError(res: Response, failure: ValidationFailure): void {
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
function readQueryValue(value: unknown): string | undefined {
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
function readQueueQuery(req: Request): Record<string, unknown> {
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
function parseQueueQuery(req: Request): QueueQueryParse {
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

/** Result of resolving a Stack reference. */
type StackResolution =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: ApiError };

/**
 * `resolve_stack` from `app/core/stack_resolver.py`.
 *
 * Three distinct failures, all measured:
 *
 * - neither `stack_id` nor `domain` supplied (including `domain: ""`, because
 *   Python's check is a truthiness test) -> **422** with a plain-string
 *   `detail`, not the 422 error array;
 * - `stack_id` given but unknown -> 404, naming the canonical lowercase UUID;
 * - `domain` given but unknown -> 404, naming the domain.
 *
 * When both are supplied `stack_id` wins, because Python branches on it first.
 * Measured: a valid `stack_id` with a nonexistent `domain` answers 201.
 */
async function resolveStack(
  tx: Database,
  stackId: string | null,
  domain: string | null,
): Promise<StackResolution> {
  const hasDomain = domain !== null && domain !== "";

  if (stackId === null && !hasDomain) {
    return {
      ok: false,
      error: apiError(422, "Either stack_id (UUID) or domain (slug) must be provided"),
    };
  }

  const rows =
    stackId !== null
      ? await tx.execute<{ readonly id: string }>(sql`
          select id from stacks where id = ${stackId}
        `)
      : await tx.execute<{ readonly id: string }>(sql`
          select id from stacks where domain = ${domain}
        `);

  const row = rows[0];
  if (row === undefined) {
    const ident = stackId !== null ? stackId : domain;
    return { ok: false, error: apiError(404, `Stack '${String(ident)}' not found`) };
  }

  return { ok: true, id: row.id };
}

/**
 * `_row_to_item` — reshapes a queue row into `BackfeedItemResponse`.
 *
 * `metadata` is `row.get("metadata") or {}`, so a NULL column reads as `{}`.
 * The four audit fields are *required-nullable* on the response model: the key
 * must be present, and `null` is the value for an unreviewed item.
 */
function toBackfeedItem(row: BackfeedRow): BackfeedItemResponseDto {
  return BackfeedItemResponse.parse({
    id: row.id,
    stack_id: row.stack_id,
    origin: row.origin,
    trigger_type: row.trigger_type,
    proposal: row.proposal,
    note: row.note,
    metadata: row.metadata ?? {},
    status: row.status,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
    review_note: row.review_note,
    created_at: row.created_at,
  });
}

/**
 * Reads a stored proposal back out of `jsonb`.
 *
 * The queue is only ever written by {@link flagItem}, which stores an already
 * validated proposal, so this cannot fail for a row this server created. A
 * hand-edited row would throw here and surface as a 500, which is what the
 * Python oracle does too (it indexes the raw dict and raises `KeyError`).
 */
function readStoredProposal(raw: unknown): BackfeedProposalDto {
  const parsed = BackfeedProposal.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError("stored backfeed proposal does not match BackfeedProposal");
  }
  return parsed.data;
}

/**
 * `POST /aks/v1/backfeed/flag` — queue a proposal for review, 201.
 *
 * Validation order is contractual and measured:
 *
 * 1. body shape (Pydantic) -> 422 array;
 * 2. empty proposal -> **400**, and it comes *before* the Stack lookup
 *    (measured: `{"proposal": {}}` with no stack answers 400, not 422);
 * 3. Stack resolution -> 422 or 404.
 *
 * Nothing is written to the ontology here: the item is stored `pending` and
 * stays that way until approved.
 */
async function flagItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = BackfeedFlagRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;

  if (payload.proposal.entities.length === 0 && payload.proposal.relationships.length === 0) {
    sendApiError(res, apiError(400, "Proposal must include at least one entity or relationship"));
    return;
  }

  const stack = await resolveStack(tx, payload.stack_id, payload.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  // The two `jsonb` arguments are serialized to text: postgres-js cannot bind a
  // JS object as a `jsonb` parameter (it throws ERR_INVALID_ARG_TYPE), while a
  // JSON string is accepted and cast by Postgres. The explicit `::jsonb` makes
  // that cast part of the statement rather than an inference.
  const rows = await tx.execute<BackfeedRow>(sql`
    insert into backfeed_queue (
      stack_id, origin, trigger_type, proposal,
      note, metadata, status
    )
    values (${stack.id}, ${payload.origin}, ${payload.trigger_type},
            ${JSON.stringify(payload.proposal)}::jsonb, ${payload.note},
            ${JSON.stringify(payload.metadata)}::jsonb, 'pending')
    returning ${sql.raw(BACKFEED_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into backfeed_queue returned no row");
  }

  res.status(201).json(toBackfeedItem(row));
}

/**
 * `GET /aks/v1/backfeed/queue` — list queue items, defaulting to pending only.
 *
 * `item_status=all` (and any falsy value, e.g. `item_status=`) disables the
 * filter; an empty value is *not* treated as invalid, which is why the check is
 * `item_status && item_status !== "all"` in Python and `!== ""` here. Measured:
 * `?item_status=` returns every status while `?item_status=PENDING` answers 400
 * — the comparison is case-sensitive.
 */
async function listQueue(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const query = parseQueueQuery(req);
  if (!query.ok) {
    sendValidationError(res, query.failure);
    return;
  }

  const stack = await resolveStack(tx, query.stackId, query.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const itemStatus = query.itemStatus;
  const filterByStatus =
    itemStatus !== null &&
    itemStatus !== "" &&
    itemStatus !== "all";

  if (filterByStatus && !QUEUE_STATUSES.includes(itemStatus)) {
    sendApiError(res, apiError(400, "status must be pending, approved, rejected, or all"));
    return;
  }

  const statusClause = filterByStatus ? sql`and status = ${itemStatus}` : sql.empty();

  const rows = await tx.execute<BackfeedRow>(sql`
    select ${sql.raw(BACKFEED_COLUMNS)}
    from backfeed_queue
    where stack_id = ${stack.id}
    ${statusClause}
    order by created_at desc
    limit ${query.limit}
  `);

  res.json(rows.map(toBackfeedItem));
}

/** `GET /aks/v1/backfeed/:item_id` — one item, or 404. */
async function getItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const raw = req.params["item_id"];
  const params = BackfeedItemParams.safeParse({ item_id: raw });
  if (!params.success) {
    sendValidationError(res, toFastApiValidationError(params.error, "path", { item_id: raw }));
    return;
  }

  const rows = await tx.execute<BackfeedRow>(sql`
    select ${sql.raw(BACKFEED_COLUMNS)}
    from backfeed_queue
    where id = ${params.data.item_id}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Backfeed item ${params.data.item_id} not found`));
    return;
  }

  res.json(toBackfeedItem(row));
}

/**
 * `POST /aks/v1/backfeed/approve` — absorb the proposal, 200.
 *
 * Three measured outcomes beyond the happy path:
 *
 * - unknown id -> 404 `Backfeed item <uuid> not found`;
 * - already **rejected** -> 409, and the ontology is untouched;
 * - already **approved** -> 200 with both counts set to **0**. Re-approval is
 *   idempotent and does not re-absorb, so the second call reports zeros rather
 *   than the counts the first call reported.
 *
 * The response is `BackfeedApprovalResult` — counts, not the item — so an
 * approval never returns the queue row.
 */
async function approveItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = BackfeedApprovalRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;

  const rows = await tx.execute<{
    readonly id: string;
    readonly stack_id: string;
    readonly status: string;
    readonly proposal: unknown;
  }>(sql`
    select id, stack_id, status, proposal
    from backfeed_queue
    where id = ${payload.item_id}
  `);

  const item = rows[0];
  if (item === undefined) {
    sendApiError(res, apiError(404, `Backfeed item ${payload.item_id} not found`));
    return;
  }

  if (item.status === "rejected") {
    sendApiError(res, apiError(409, "Cannot approve an item that has been rejected"));
    return;
  }

  if (item.status === "approved") {
    // Idempotent path: do not absorb again.
    const result: BackfeedApprovalResultDto = {
      item_id: payload.item_id,
      entities_absorbed: 0,
      relationships_absorbed: 0,
      status: "approved",
    };
    res.json(BackfeedApprovalResult.parse(result));
    return;
  }

  const proposal = readStoredProposal(item.proposal);

  const absorbed = await consolidateBackfeedProposal(
    tx,
    item.stack_id,
    proposal.entities,
    proposal.relationships,
  );

  await tx.execute(sql`
    update backfeed_queue
    set status = 'approved',
        reviewed_at = now(),
        reviewed_by = ${payload.reviewed_by},
        review_note = ${payload.review_note}
    where id = ${payload.item_id}
  `);

  const result: BackfeedApprovalResultDto = {
    item_id: payload.item_id,
    entities_absorbed: absorbed.entitiesAbsorbed,
    relationships_absorbed: absorbed.relationshipsAbsorbed,
    status: "approved",
  };
  res.json(BackfeedApprovalResult.parse(result));
}

/**
 * `POST /aks/v1/backfeed/reject` — mark an item rejected, 200.
 *
 * The `and status = 'pending'` guard means a second reject (or a reject of an
 * already-approved item) answers 404 with the combined `not found or not in
 * pending status` message, rather than 409. Rejecting never touches the
 * ontology.
 */
async function rejectItem(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  const rawBody: unknown = req.body;
  const parsed = BackfeedRejectionRequest.safeParse(rawBody);
  if (!parsed.success) {
    sendValidationError(res, toFastApiValidationError(parsed.error, "body", rawBody));
    return;
  }

  const payload = parsed.data;

  const rows = await tx.execute<BackfeedRow>(sql`
    update backfeed_queue
    set status = 'rejected',
        reviewed_at = now(),
        reviewed_by = ${payload.reviewed_by},
        review_note = ${payload.review_note}
    where id = ${payload.item_id}
      and status = 'pending'
    returning ${sql.raw(BACKFEED_COLUMNS)}
  `);

  const row = rows[0];
  if (row === undefined) {
    sendApiError(
      res,
      apiError(
        404,
        `Backfeed item ${payload.item_id} not found or not in pending status`,
      ),
    );
    return;
  }

  res.json(toBackfeedItem(row));
}

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface BackfeedRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: BackfeedRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/aks/v1/backfeed` router.
 *
 * Auth is mounted on the router, mirroring
 * `dependencies=[Depends(require_api_key)]`, and every handler runs through the
 * route-level transaction wrapper — never a transaction-owning `app.use`
 * middleware. `approve` relies on that: the ontology writes and the queue status
 * flip share one transaction, so a failure cannot leave absorbed entities behind
 * for an item that still reads `pending`.
 */
export function createBackfeedRouter(
  deps: BackfeedRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/flag", deps.wrap(flagItem));
  router.get("/queue", deps.wrap(listQueue));
  router.post("/approve", deps.wrap(approveItem));
  router.post("/reject", deps.wrap(rejectItem));
  // Registered last: `:item_id` would otherwise shadow the literal paths above.
  router.get("/:item_id", deps.wrap(getItem));

  return router;
}
