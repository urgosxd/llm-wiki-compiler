/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/prune-harness.ts
 * @description Fixtures the classification-failure retention suites share: seeding
 * `kg_classification_log` events at a chosen AGE, and snapshotting the tables a prune
 * must never touch.
 *
 * ## Why age is a fixture parameter
 *
 * Retention is a time-window rule, so a test that seeds rows with the column default
 * (`now()`) can only ever prove the negative half of it: nothing recent is deleted.
 * Proving the positive half means seeding an event that is genuinely older than the
 * window, and the only honest way to do that is to write `created_at` explicitly
 * rather than to reach into the constant under test. Ages are therefore expressed in
 * MINUTES so a seed can say `40 * MINUTES_PER_DAY` without fractional-day arithmetic,
 * while the SAME row still reads as an ordinary append-only event to every other
 * reader.
 *
 * ## Why the snapshot is whole-row text
 *
 * Test (e) claims the prune leaves every other table byte-identical. A projection of
 * the columns the author remembered would quietly pass while, say, `confidence` or
 * `updated_at` changed. `row_to_json(t)::text` captures the entire row as the server
 * sees it, ordered by primary key, so one deep-equality between two snapshots covers
 * every column of every row that exists — and a row that appeared or vanished moves
 * the array, not just a field.
 *
 * ## Cleanup
 *
 * Nothing here registers its own cleanup: every child table used below carries
 * `on delete cascade` from `stacks`, so `deleteFixtureRows()` from the ingest harness
 * removes a seeded graph together with its Stack.
 */
import { sql } from "drizzle-orm";

import type { Database } from "../../db.js";
import { withFixtureTenant } from "../fixture-tenant.js";
import { database } from "../ingest-harness.js";

/** Minutes in a day, so an age in days is expressed without fractional arithmetic. */
export const MINUTES_PER_DAY = 24 * 60;

/** One `kg_classification_log` event to insert at a chosen age. */
export interface LogRowSeed {
  readonly stackId: string;
  readonly candidateRef: string;
  readonly reason: string;
  /** How long ago the event happened, in minutes, relative to the server's `now()`. */
  readonly ageInMinutes: number;
  /** The state the row holds after the event; a failure keeps whatever it had. */
  readonly newState?: "classified" | "failed";
}

/**
 * One history row as a retention assertion reads it, oldest first.
 *
 * A type alias rather than an interface: `tx.execute<T>` constrains the row to
 * `Record<string, unknown>`, and only an alias gets the implicit index signature.
 */
export type ClassificationLogRow = {
  readonly id: string;
  readonly candidate_ref: string;
  readonly new_state: string;
  readonly reason: string | null;
  readonly created_at: string;
};

/**
 * What a prune must leave alone: three tables whole-row, plus the classification
 * state they project.
 *
 * `classificationStates` is redundant with `entities` on purpose. The column set of
 * `ontology_entities` is wide and can change, while "this fact is still a verified
 * Role" is the fact the operation is given permission NOT to touch, and it should stay
 * readable in a failure message even if a column is added.
 */
export interface GraphSnapshot {
  readonly entities: readonly string[];
  readonly relations: readonly string[];
  readonly evidence: readonly string[];
  readonly classificationStates: readonly string[];
}

/**
 * Inserts one classification event at a chosen age.
 *
 * @param seed - The event, its candidate and how old it should look.
 */
export async function seedLogRow(seed: LogRowSeed): Promise<void> {
  const state = seed.newState ?? "classified";
  await withFixtureTenant(database(), { stackId: seed.stackId }, (tx) =>
    tx.execute(sql`
      insert into kg_classification_log (
        stack_id, candidate_kind, candidate_ref, previous_state, new_state, reason, created_at
      )
      values (
        ${seed.stackId}, 'entity', ${seed.candidateRef}, ${state}, ${state}, ${seed.reason},
        now() - make_interval(mins => ${seed.ageInMinutes}::int)
      )
    `),
  );
}

/**
 * Inserts several events in the order given, one statement each.
 *
 * Separate statements rather than one multi-row insert: `now()` is fixed at
 * transaction start, so a single statement would give every row the same `created_at`
 * and leave the "oldest first" reading of the history up to a tie-break.
 *
 * @param seeds - The events to append.
 */
export async function seedLogRows(seeds: readonly LogRowSeed[]): Promise<void> {
  for (const seed of seeds) await seedLogRow(seed);
}

/**
 * Every history row of one Stack, oldest first.
 *
 * @param stackId - The Stack whose history is read.
 * @returns The rows in history order.
 */
export async function logRows(stackId: string): Promise<readonly ClassificationLogRow[]> {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<ClassificationLogRow>(sql`
      select id, candidate_ref, new_state, reason, created_at
      from kg_classification_log
      where stack_id = ${stackId}
      order by created_at, id
    `),
  );
}

/**
 * Seeds a minimal but complete graph: a document, two classified entities, the edge
 * between them and one located quote.
 *
 * The entities are `verified` on purpose: a human-reviewed fact is the row a prune is
 * least allowed to disturb, so it is the one the byte-identical assertion is made on.
 *
 * @param stackId - The Stack the graph belongs to.
 */
export async function seedGraphFixture(stackId: string): Promise<void> {
  await withFixtureTenant(database(), { stackId }, async (tx) => {
    const documentId = await insertDocument(tx, stackId);
    const from = await insertEntity(tx, stackId, "Comité de Cambios", "Role");
    const to = await insertEntity(tx, stackId, "Gestión de cambios", "Process");
    await insertRelation(tx, stackId, from, to);
    await insertEvidence(tx, stackId, documentId, "Comité de Cambios");
  });
}

/**
 * Reads the whole graph of one Stack as text rows, for a before/after comparison.
 *
 * @param stackId - The Stack to snapshot.
 * @returns Every protected table's rows, ordered by primary key.
 */
export async function snapshotGraph(stackId: string): Promise<GraphSnapshot> {
  return withFixtureTenant(database(), { stackId }, async (tx) => ({
    entities: await rowsAsText(tx, "ontology_entities", stackId),
    relations: await rowsAsText(tx, "ontology_relationships", stackId),
    evidence: await rowsAsText(tx, "kg_evidence", stackId),
    classificationStates: await classificationStates(tx, stackId),
  }));
}

/**
 * Every row of one table as JSON text, ordered by id.
 *
 * @param tx - Tenant-bound transaction.
 * @param table - Table name, always one of this module's own literals.
 * @param stackId - The Stack whose rows are read.
 */
async function rowsAsText(
  tx: Database,
  table: string,
  stackId: string,
): Promise<readonly string[]> {
  const rows = await tx.execute<{ row: string }>(sql`
    select row_to_json(record)::text as row
    from ${sql.raw(table)} record
    where record.stack_id = ${stackId}
    order by record.id
  `);
  return rows.map((entry) => entry.row);
}

/**
 * The classification state of every entity of one Stack, in name order.
 *
 * @param tx - Tenant-bound transaction.
 * @param stackId - The Stack whose state is read.
 */
async function classificationStates(
  tx: Database,
  stackId: string,
): Promise<readonly string[]> {
  const rows = await tx.execute<{
    name: string;
    classification_state: string | null;
    canonical_type: string | null;
  }>(sql`
    select name, classification_state, canonical_type
    from ontology_entities
    where stack_id = ${stackId}
    order by name
  `);
  return rows.map(
    (row) => `${row.name}|${String(row.classification_state)}|${String(row.canonical_type)}`,
  );
}

/**
 * Inserts the fixture document the evidence row quotes.
 *
 * @param tx - Tenant-bound transaction.
 * @param stackId - The Stack the document belongs to.
 * @returns The new document's id.
 */
async function insertDocument(tx: Database, stackId: string): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
    values (
      ${stackId}, 'fixture.txt', ${`uploads/${stackId}/fixture.txt`}, 46, ${`hash-${stackId}`}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("the fixture document was not inserted");
  return id;
}

/**
 * Inserts one classified entity under a catalog type.
 *
 * @param tx - Tenant-bound transaction.
 * @param stackId - The Stack the entity belongs to.
 * @param name - Entity name, unique inside the Stack.
 * @param canonicalType - The catalog type the row was classified as.
 * @returns The new entity's id.
 */
async function insertEntity(
  tx: Database,
  stackId: string,
  name: string,
  canonicalType: string,
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into ontology_entities (
      stack_id, name, type, classification_state, canonical_type,
      catalog_version, classifier_version, verified
    )
    values (
      ${stackId}, ${name}, ${canonicalType}, 'classified', ${canonicalType},
      '1.0.0', 'test-classifier', true
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture entity ${name} was not inserted`);
  return id;
}

/**
 * Inserts one classified edge between two entities.
 *
 * @param tx - Tenant-bound transaction.
 * @param stackId - The Stack the edge belongs to.
 * @param fromId - Source entity id.
 * @param toId - Target entity id.
 */
async function insertRelation(
  tx: Database,
  stackId: string,
  fromId: string,
  toId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into ontology_relationships (
      stack_id, from_entity_id, to_entity_id, type, classification_state, canonical_type
    )
    values (${stackId}, ${fromId}, ${toId}, 'executes', 'classified', 'executes')
  `);
}

/**
 * Inserts one located textual quote for a candidate.
 *
 * @param tx - Tenant-bound transaction.
 * @param stackId - The Stack the quote belongs to.
 * @param documentId - Document the quote was found in.
 * @param candidateRef - Candidate the quote supports.
 */
async function insertEvidence(
  tx: Database,
  stackId: string,
  documentId: string,
  candidateRef: string,
): Promise<void> {
  await tx.execute(sql`
    insert into kg_evidence (
      stack_id, candidate_kind, candidate_ref, document_id,
      evidence_text, char_start, char_end
    )
    values (
      ${stackId}, 'entity', ${candidateRef}, ${documentId},
      'El Comité de Cambios ejecuta la gestión de cambios.', 0, 46
    )
  `);
}
