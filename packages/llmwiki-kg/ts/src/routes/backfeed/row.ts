/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/row.ts
 * @description Reshaping a `backfeed_queue` row into the response DTO.
 *
 * Split out of `routes/backfeed.ts` as its own unit because the JSON key order of
 * every response comes from `BackfeedItemResponse`'s declaration order, exactly
 * like Python's `BackfeedItemResponse(**row)` — the row is handed to the Zod
 * schema, which both validates and fixes the order.
 *
 * Postgres `jsonb` does **not** preserve object key order (it stores keys sorted
 * by length then bytes), so re-parsing the proposal through `BackfeedProposal` is
 * what keeps the nested entity objects in the oracle's order.
 */

import { BackfeedItemResponse, BackfeedProposal } from "../../dto.js";
import type { BackfeedItemResponseDto, BackfeedProposalDto } from "../../dto.js";
import type { BackfeedRow } from "./model.js";

/**
 * `_row_to_item` — reshapes a queue row into `BackfeedItemResponse`.
 *
 * `metadata` is `row.get("metadata") or {}`, so a NULL column reads as `{}`.
 * The four audit fields are *required-nullable* on the response model: the key
 * must be present, and `null` is the value for an unreviewed item.
 */
export function toBackfeedItem(row: BackfeedRow): BackfeedItemResponseDto {
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
export function readStoredProposal(raw: unknown): BackfeedProposalDto {
  const parsed = BackfeedProposal.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError("stored backfeed proposal does not match BackfeedProposal");
  }
  return parsed.data;
}
