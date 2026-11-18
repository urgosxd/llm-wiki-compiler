/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/stack-totals.ts
 * @description How many graph rows one Stack holds, counted the way both pipeline
 * responses report them.
 *
 * ## Why this is shared instead of written twice
 *
 * `IngestionResult.entities_in_stack` and `CompileResult.entities_in_stack` are the same
 * number from the same two tables, and they must never disagree: a caller comparing an
 * ingest response with a compile response for one Stack is comparing reports of the same
 * stored state. Two copies of the queries would be two places to fix when the graph gains
 * a table, and the drift would be invisible — every response would still parse.
 *
 * ## When the count is taken
 *
 * The caller runs this INSIDE the transaction that persists its own decisions, so the
 * totals include the run that is reporting them and no client can see a total that the
 * commit has not landed yet.
 */

import { sql } from "drizzle-orm";

import type { Database } from "../../db.js";

/** One Stack's graph size, as both pipeline responses report it. */
export interface StackTotals {
  /** Rows in `ontology_entities` for this Stack. */
  readonly entities: number;
  /** Rows in `ontology_relationships` for this Stack. */
  readonly relationships: number;
}

/**
 * Counts one Stack's entity and relationship rows.
 *
 * `::int` on each count is not cosmetic: postgres-js hands a bare `count(*)` back as a
 * string, and a string on a wire shape declared `z.number()` fails the parse instead of
 * reaching the caller.
 *
 * @param tx - The transaction carrying the reads; the tenant must be bound by the caller.
 * @param stackId - The Stack whose rows are counted.
 * @returns Both totals, zero when the Stack holds nothing.
 */
export async function stackTotals(tx: Database, stackId: string): Promise<StackTotals> {
  const entityTotals = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ontology_entities where stack_id = ${stackId}
  `);
  const relationshipTotals = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ontology_relationships where stack_id = ${stackId}
  `);
  return {
    entities: entityTotals[0]?.n ?? 0,
    relationships: relationshipTotals[0]?.n ?? 0,
  };
}
