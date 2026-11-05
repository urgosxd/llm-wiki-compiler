/**
 * @file test/kg-mcp-e2e/probe-database.ts
 * @description The real rows the probe queries, and the row counts it compares.
 *
 * Two Stacks with deliberately disjoint vocabulary: every entity, relationship and
 * description of the second one is spelled with "Beta", so "did this answer cross a
 * Stack boundary" is answered by the payload itself and not by a comment.
 *
 * Confidences are drawn from {0.25, 0.5, 0.75}: all exactly representable as a
 * Postgres `real`, so the two-decimal formatting the MCP layer applies is not
 * decided by binary rounding.
 */

import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";

/** A Stack this probe created and therefore knows everything about. */
export interface SeededStack {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  /** Timestamps are written explicitly so the `list_stacks` payload is exact. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The two Stacks, and the ids inside them, the assertions refer to. */
export interface Seed {
  readonly alpha: SeededStack;
  readonly beta: SeededStack;
}

/** Row counts a refusal must not move. */
export interface RowCounts {
  readonly stacks: number;
  readonly entities: number;
  readonly relationships: number;
  readonly documents: number;
}

/** One stack row, inserted with every contract-visible field pinned. */
async function insertStack(sql: Sql, row: SeededStack, description: string | null): Promise<void> {
  await sql`
    insert into stacks (id, name, domain, description, scope, compilation_strategy, created_at, updated_at)
    values (${row.id}, ${row.name}, ${row.domain}, ${description}, 'stack', 'incremental',
            ${row.createdAt}::timestamptz, ${row.updatedAt}::timestamptz)
  `;
}

/** One entity, inserted with the confidence the assertion expects to read back. */
async function insertEntity(
  sql: Sql,
  stackId: string,
  name: string,
  type: string,
  confidence: number,
  description: string | null,
  verified: boolean,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into ontology_entities
      (id, stack_id, name, type, description, confidence, verified, extracted_by_model, source_kind, pipeline)
    values (${id}, ${stackId}, ${name}, ${type}, ${description}, ${confidence}, ${verified},
            'probe-extractor', 'document', 'probe-pipeline')
  `;
  return id;
}

/** One directed edge between two entities of the same Stack. */
async function insertEdge(
  sql: Sql,
  stackId: string,
  from: string,
  to: string,
  type: string,
  confidence: number,
): Promise<void> {
  await sql`
    insert into ontology_relationships (id, stack_id, from_entity_id, to_entity_id, type, confidence)
    values (${randomUUID()}, ${stackId}, ${from}, ${to}, ${type}, ${confidence})
  `;
}

/**
 * Create the two Stacks, their entities and their edges.
 *
 * @param sql - Client on the probe's own database.
 * @returns The Stacks whose ids the tests address the tools with.
 */
export async function seedProbeStacks(sql: Sql): Promise<Seed> {
  const alpha: SeededStack = {
    id: randomUUID(),
    name: "Probe Alpha",
    domain: "probe-alpha",
    createdAt: "2026-01-01T00:00:00.000000Z",
    updatedAt: "2026-01-01T00:00:00.000000Z",
  };
  const beta: SeededStack = {
    id: randomUUID(),
    name: "Probe Beta",
    domain: "probe-beta",
    createdAt: "2026-01-02T00:00:00.000000Z",
    updatedAt: "2026-01-02T00:00:00.000000Z",
  };

  await insertStack(sql, alpha, "The Stack this probe queries first.");
  await insertStack(sql, beta, null);

  const alphaGateway = await insertEntity(
    sql, alpha.id, "Alpha Gateway", "System", 0.75, "Routes alpha traffic.", true,
  );
  const alphaLedger = await insertEntity(
    sql, alpha.id, "Alpha Ledger", "Process", 0.5, null, false,
  );
  const betaGateway = await insertEntity(
    sql, beta.id, "Beta Gateway", "System", 0.5, "Routes beta traffic.", true,
  );
  const betaLedger = await insertEntity(
    sql, beta.id, "Beta Ledger", "Process", 0.25, null, false,
  );

  await insertEdge(sql, alpha.id, alphaGateway, alphaLedger, "requires", 0.75);
  await insertEdge(sql, beta.id, betaGateway, betaLedger, "requires", 0.5);

  return { alpha, beta };
}

/**
 * How many rows of each kind the probe's database holds right now.
 *
 * Read through SQL against the store the API also reads: "a refused call changed
 * nothing" is a claim about stored data, so it is measured at the store.
 *
 * @param sql - Client on the probe's own database.
 * @returns The four counts every refusal must leave untouched.
 */
export async function rowCounts(sql: Sql): Promise<RowCounts> {
  const [counts] = await sql<RowCounts[]>`
    select
      (select count(*)::int from stacks) as stacks,
      (select count(*)::int from ontology_entities) as entities,
      (select count(*)::int from ontology_relationships) as relationships,
      (select count(*)::int from stack_documents) as documents
  `;
  if (counts === undefined) throw new Error("the row-count query returned no row");
  return counts;
}
