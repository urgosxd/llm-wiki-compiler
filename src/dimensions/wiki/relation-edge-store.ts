/**
 * @file src/dimensions/wiki/relation-edge-store.ts
 * @description The wiki's typed graph edges, as rows instead of `relations.jsonl`.
 *
 * ## What the file carried, and what has to survive
 *
 * `relations.jsonl` was append-only and per-record checksummed: each line held a
 * `RelationRef` plus a `checksum` recomputed on read, so a flipped byte was
 * detectable. The DEDUP key was not the endpoints — it was endpoints + type +
 * evidence fingerprint, folded into `contentHash`, because an edge that GAINS
 * evidence is a different edge and must not collide with the one it supersedes.
 *
 * Both properties are preserved here and neither is reimplemented: `checksum` comes
 * from the same `recordChecksum` the file used, and `contentHash` from the same
 * `relationContentHash`, so a row and a line describe an edge identically.
 *
 * ## What the move buys
 *
 * The file was scoped to a PROJECT: two checkouts of one Stack each held their own
 * graph and neither could see the other's edges. Rows are scoped to the STACK.
 *
 * ## What it costs, stated plainly
 *
 * The file was append-only by construction; a table allows UPDATE and DELETE. The
 * append-only DISCIPLINE is preserved by never deleting: a compaction marks the old
 * edge `superseded_by` and inserts the replacement, so read history stays readable
 * and the checksum of a superseded edge still verifies.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { recordChecksum } from "../../relations/store-record.js";
import type { RelationRef } from "../../relations/types.js";
import type { OperationBinding } from "../../utils/operation-binding.js";

/** One `relation_edges` row as Postgres returns it. */
interface RelationRow extends Record<string, unknown> {
  readonly relation_id: string;
  readonly relation_type: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly attributes: unknown;
  readonly evidence: unknown;
  readonly content_hash: string;
  readonly checksum: string;
  readonly operation_binding: unknown;
  readonly superseded_by: string | null;
  readonly at: string | Date;
}

/** An edge plus whatever the file's read path also returned. */
export interface StoredRelationEdge {
  readonly ref: RelationRef;
  readonly operationBinding?: OperationBinding;
}

/**
 * Rebuild the `RelationRef` a caller already understands.
 *
 * @param row - A `relation_edges` row.
 * @returns The equivalent record.
 */
function toStoredEdge(row: RelationRow): StoredRelationEdge {
  const ref: RelationRef = {
    id: row.relation_id as RelationRef["id"],
    type: row.relation_type,
    from: row.from_id as RelationRef["from"],
    to: row.to_id as RelationRef["to"],
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
    ...(row.evidence === null ? {} : { evidence: row.evidence as RelationRef["evidence"] }),
    contentHash: row.content_hash,
  };
  return {
    ref,
    ...(row.operation_binding === null
      ? {}
      : { operationBinding: row.operation_binding as OperationBinding }),
  };
}

/**
 * Read one Stack's live edges, superseded ones excluded.
 *
 * A superseded edge is not deleted — it stays readable as history — but it is not
 * part of the graph a query walks, which is what "live" means here.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose edges to read.
 * @returns The live edges, in creation order.
 */
export async function readRelationEdges(
  db: Database,
  stackId: string,
): Promise<StoredRelationEdge[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<RelationRow>(sql`
      select relation_id, relation_type, from_id, to_id, attributes, evidence,
             content_hash, checksum, operation_binding, superseded_by, at
      from wiki.relation_edges
      where stack_id = ${stackId} and superseded_by is null
      order by at asc, relation_id asc
    `);
    return rows.map(toStoredEdge);
  });
}

/**
 * Insert one edge, checksummed exactly as the file store checksummed it.
 *
 * ## Why a conflict is not swallowed
 *
 * The dedup index is `(stack_id, type, from, to, content_hash)`. Re-inserting the
 * SAME edge — same evidence, same endpoints — is a no-op and correct, because the
 * caller asked to record a fact already recorded. But a DIFFERENT `contentHash` on
 * the same endpoints inserts a new row on purpose: that is an edge whose evidence
 * changed, and collapsing it would silently lose provenance.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the edge.
 * @param ref - The relation to record.
 * @param binding - Operation binding, when an operation-bundle apply produced it.
 * @returns True when a row was inserted, false when the edge was already present.
 */
export async function upsertRelationEdge(
  db: Database,
  stackId: string,
  ref: RelationRef,
  binding?: OperationBinding,
): Promise<boolean> {
  const checksum = recordChecksum(ref, binding);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const inserted = await tx.execute<{ relation_id: string }>(sql`
      insert into wiki.relation_edges
        (stack_id, relation_id, relation_type, from_id, to_id, attributes, evidence,
         content_hash, checksum, operation_binding, at)
      values (
        ${stackId}, ${ref.id}, ${ref.type}, ${ref.from}, ${ref.to},
        ${JSON.stringify(ref.attributes)}::jsonb,
        ${ref.evidence === undefined ? null : JSON.stringify(ref.evidence)}::jsonb,
        ${ref.contentHash}, ${checksum},
        ${binding === undefined ? null : JSON.stringify(binding)}::jsonb,
        ${new Date().toISOString()}::timestamptz
      )
      on conflict (stack_id, relation_type, from_id, to_id, content_hash) do nothing
      returning relation_id
    `);
    return inserted.length > 0;
  });
}

/**
 * Mark one edge superseded by another, preserving it as history.
 *
 * Never deletes: the row's checksum must keep verifying, and a reader asking
 * "what did this edge look like before" must still have an answer.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the edge.
 * @param relationId - The edge being superseded.
 * @param supersededBy - The edge that replaces it.
 */
export async function supersedeRelationEdge(
  db: Database,
  stackId: string,
  relationId: string,
  supersededBy: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      update wiki.relation_edges
      set superseded_by = ${supersededBy}
      where stack_id = ${stackId} and relation_id = ${relationId}
    `);
  });
}
