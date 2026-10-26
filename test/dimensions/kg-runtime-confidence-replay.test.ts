/**
 * @file test/dimensions/kg-runtime-confidence-replay.test.ts
 * @description A replayed `kg` commit must NOT inflate entity confidence. This
 * suite pins the defect and then the fix.
 *
 * ## The defect
 *
 * The port promises `commit` is idempotent, because the outbox recovers a
 * half-applied ingest by REPLAYING it (`reconcile.ts`). Rows and edges honour
 * that: contributions are `on conflict do nothing`, edges upsert with
 * `greatest(confidence, …)`. Entities do not.
 *
 * `updateEntity` computes `min(1.0, existing + ENTITY_CONFIDENCE_BUMP)` where the
 * bump is `0.05`, while extraction always emits `EXTRACTED_CONFIDENCE = 0.7`. So
 * each replay walks an entity 0.7 → 0.75 → 0.8 → … → 1.0.
 *
 * That is not cosmetic. `ontology_entities.confidence` is documented in the schema
 * as "Increases during consolidation as more sources corroborate this entity", and
 * the graph is queried by it. After retries the graph CLAIMS corroboration that
 * never happened — the confidence column stops meaning "how many sources agree"
 * and starts meaning "how many times we retried".
 *
 * ## Why the fix is expressible at all
 *
 * Measured: `insert … on conflict … do nothing RETURNING` yields ONE row when the
 * contribution is new and ZERO rows on a duplicate. So `recordContribution` can
 * report which case it hit, and the bump can be conditional on a genuinely new
 * contribution.
 *
 * ## Scope note
 *
 * A brand-new entity is INSERTED at `EXTRACTED_CONFIDENCE`, never bumped, so only
 * the existing-entity path needs the guard.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { consolidateEntityRows } from "llmwiki-kg";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { asAppRole } from "./kg-runtime-app-role.js";

const harness = await createKgPostgresHarness("kg-confidence-replay");
const { db, stackId, reachable } = harness;

const provisioned = await (async (): Promise<boolean> => {
  if (!reachable) return false;
  try {
    const rows = await db.execute<{ n: number }>(`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'ontology_entities'
    `);
    return (rows[0] as { n: number } | undefined)?.n === 1;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await harness.cleanup();
});

/** One extracted entity, shaped as the extractor emits it. */
function entityOf(name: string) {
  return { name, type: "concept", description: `about ${name}`, confidence: 0.7, properties: {} };
}

/** Register a document row for the harness Stack and return its id. */
async function registerDocument(slug: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(`
      insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
      values ('${stackId}', '${slug}', 'src://${slug}', 4, 'hash-${slug}')
      returning id
  `);
  return (rows[0] as { id: string }).id;
}

/** Read one entity's stored confidence. */
async function confidenceOf(name: string): Promise<number> {
  const rows = await harness.db.execute<{ confidence: number }>(`
    select confidence from ontology_entities
    where stack_id = '${stackId}' and lower(name) = lower('${name}')
  `);
  return Number((rows[0] as { confidence: number } | undefined)?.confidence);
}

/** Run one consolidation of `name` against `documentId`, as a commit would. */
async function consolidate(name: string, documentId: string): Promise<void> {
  await asAppRole(harness, async (tx) => {
    await consolidateEntityRows(tx, stackId, documentId, [entityOf(name)]);
  });
}

describe.skipIf(!provisioned)("kg entity confidence under outbox replay", () => {
  /**
   * THE DEFECT, as a measurement. A replay of the SAME document is not new
   * corroboration, so the stored confidence must not move.
   *
   * Before the fix this asserted 0.75 and 0.8 — which is exactly what the defect
   * produced, and why it is written here as the failing-then-passing case.
   */
  it("does not inflate confidence when the same document is replayed", async () => {
    const name = `Replay-${randomUUID().slice(0, 8)}`;
    const documentId = await registerDocument(`replay-${name}`);

    await consolidate(name, documentId);
    const afterFirst = await confidenceOf(name);

    // Two replays of the identical contribution, which is what reconcile does
    // after a crash between the wiki commit and the graph commit.
    await consolidate(name, documentId);
    await consolidate(name, documentId);

    expect(afterFirst).toBeCloseTo(0.7, 5);
    expect(await confidenceOf(name)).toBeCloseTo(afterFirst, 5);
  });

  /**
   * The OTHER half, and the reason the fix cannot simply delete the bump: a
   * DIFFERENT document mentioning the same entity IS new corroboration, and the
   * confidence must still rise.
   *
   * Without this case, "delete the increment" would pass the suite while breaking
   * the feature the column exists for.
   */
  it("still raises confidence when a DIFFERENT document corroborates the entity", async () => {
    const name = `Corroborate-${randomUUID().slice(0, 8)}`;
    const firstDocument = await registerDocument(`corr-a-${name}`);
    const secondDocument = await registerDocument(`corr-b-${name}`);

    await consolidate(name, firstDocument);
    const afterFirst = await confidenceOf(name);

    await consolidate(name, secondDocument);
    const afterSecond = await confidenceOf(name);

    expect(afterFirst).toBeCloseTo(0.7, 5);
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});
