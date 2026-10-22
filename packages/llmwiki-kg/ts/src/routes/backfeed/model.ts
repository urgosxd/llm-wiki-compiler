/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/model.ts
 * @description The queue row shape and its verbatim column list.
 *
 * Split out of `routes/backfeed.ts` as its own unit because the column list is a
 * contract — it repeats the Python module's `select` in order — and every query
 * in this router interpolates it.
 */

export const BACKFEED_COLUMNS =
  "id, stack_id, origin, trigger_type, proposal, note, metadata, status, reviewed_at, reviewed_by, review_note, created_at";

/** The statuses `item_status` accepts besides `all`. */
export const QUEUE_STATUSES: readonly string[] = ["pending", "approved", "rejected"];

/** A `backfeed_queue` row as selected by {@link BACKFEED_COLUMNS}. */
export type BackfeedRow = {
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
