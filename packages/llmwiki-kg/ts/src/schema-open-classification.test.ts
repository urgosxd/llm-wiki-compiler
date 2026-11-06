/**
 * @file packages/llmwiki-kg/ts/src/schema-open-classification.test.ts
 * @description The migration itself: does it upgrade a live database without loss?
 *
 * ## What this file is allowed to prove
 *
 * Only what a caller can observe: the columns, constraints and indexes the database
 * carries after the upgrade, read through `information_schema` and `pg_catalog`, and
 * the row values it holds. No private helper and no internal shape is asserted, so a
 * refactor that keeps the contract keeps this green.
 *
 * ## Why the database is built in the PRE-migration shape
 *
 * `createSuiteDatabase` applies the already-migrated schema, so it cannot represent a
 * database that predates this migration. The harness mints one from the old shape,
 * fills it with rows carrying `verified`, `confidence`, `properties`, `source_kind`
 * and `pipeline`, and then applies the migration file an operator would run. Without
 * that, "no existing row is lost" would be an assumption about SQL nobody executed.
 *
 * ## The pre-migration control
 *
 * The legacy column list is captured BEFORE the migration runs and asserted absent
 * afterwards, so "the migration is what added this" is a check and not a story: a
 * suite that only asserted the final shape would also pass against a database where
 * the migration silently did nothing.
 *
 * The identity, evidence and history contracts live in
 * `schema-identity-evidence.test.ts`; both files share the fixtures in
 * `schema-open-classification-harness.ts`.
 */
import type { Sql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import {
  MIGRATION_SQL,
  TABLE_PAIRS,
  columnNames,
  databaseShape,
  drizzleColumnNames,
  freshDatabaseUrl,
  openMigratedLegacyDatabase,
} from "./schema-open-classification-harness.js";
import type { LegacyDatabase } from "./schema-open-classification-harness.js";
import { withClient } from "./testing/per-run-database.js";

/** The upgraded pre-migration database, built once for this file. */
const legacy: LegacyDatabase = await openMigratedLegacyDatabase();

afterAll(async () => {
  await legacy.drop();
});

/** Every migration-relevant row value, as a stable string, for "nothing changed" checks. */
async function rowSnapshot(client: Sql): Promise<string> {
  const entities = await client<{ row: string | null }[]>`
    select json_agg(row_to_json(t) order by t.id)::text as row from (
      select id, name, identity_key, classification_state, canonical_type, proposed_type,
             support_state, verified, confidence, properties, source_kind, pipeline
      from ontology_entities
    ) t
  `;
  const relationships = await client<{ row: string | null }[]>`
    select json_agg(row_to_json(t) order by t.id)::text as row from (
      select id, identity_key, predicate, classification_state, canonical_type,
             support_state, compatibility, verified, confidence
      from ontology_relationships
    ) t
  `;
  return JSON.stringify([entities[0]?.row ?? null, relationships[0]?.row ?? null]);
}

describe("the migration", () => {
  it("adds every open-classification column to a pre-migration database", async () => {
    await withClient(legacy.url, async (client) => {
      expect(legacy.entityColumnsBefore).not.toContain("classification_state");
      expect(legacy.entityColumnsBefore).not.toContain("identity_key");
      expect(await columnNames(client, "ontology_entities")).toEqual(
        expect.arrayContaining([
          "classification_state",
          "canonical_type",
          "proposed_type",
          "support_state",
          "jev_choice",
          "jev_confidence",
          "jev_top_probability",
          "jev_model",
          "jev_classified_at",
          "catalog_version",
          "classifier_version",
          "classification_updated_at",
          "identity_key",
        ]),
      );
    });
  });

  it("adds the relationship and Stack columns the concept needs", async () => {
    await withClient(legacy.url, async (client) => {
      expect(await columnNames(client, "ontology_relationships")).toEqual(
        expect.arrayContaining([
          "predicate",
          "canonical_type",
          "classification_state",
          "support_state",
          "compatibility",
          "jev_choice",
          "jev_confidence",
          "jev_top_probability",
          "jev_model",
          "jev_classified_at",
          "catalog_version",
          "classifier_version",
          "classification_updated_at",
          "identity_key",
        ]),
      );
      expect(await columnNames(client, "stacks")).toEqual(
        expect.arrayContaining(["type_catalog", "catalog_version"]),
      );
      expect(await columnNames(client, "kg_evidence")).toEqual(
        expect.arrayContaining([
          "candidate_kind",
          "candidate_ref",
          "document_id",
          "chunk_id",
          "chunk_index",
          "evidence_text",
          "char_start",
          "char_end",
          "normalized_match",
          "evidence_kind",
          "model",
          "pipeline_version",
          "catalog_version",
        ]),
      );
    });
  });

  it("agrees with a database built from schema.sql", async () => {
    const migrated = await withClient(legacy.url, databaseShape);
    const fresh = await withClient(freshDatabaseUrl(), databaseShape);
    expect(migrated).toEqual(fresh);
  });

  it("mirrors every database column in the drizzle definitions", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      for (const [table, pgTable] of TABLE_PAIRS) {
        expect({ table, columns: drizzleColumnNames(pgTable) }).toEqual({
          table,
          columns: await columnNames(client, table),
        });
      }
    });
  });

  it("secures the evidence and history tables for tenancy on both paths", async () => {
    for (const url of [freshDatabaseUrl(), legacy.url]) {
      const secured = await withClient(url, (client) =>
        client<{ table: string; relrowsecurity: boolean }[]>`
          select c.relname as table, c.relrowsecurity from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in ('kg_evidence', 'kg_classification_log')
          order by c.relname`,
      );
      expect(secured).toEqual([
        { table: "kg_classification_log", relrowsecurity: true },
        { table: "kg_evidence", relrowsecurity: true },
      ]);
    }
  });

  it("can be applied twice without changing a single row", async () => {
    const first = await withClient(legacy.url, rowSnapshot);
    expect(first).not.toBe(JSON.stringify([null, null]));
    await withClient(legacy.url, (client) => client.unsafe(MIGRATION_SQL));
    expect(await withClient(legacy.url, rowSnapshot)).toBe(first);
  });

});

describe("the backfill", () => {
  it("keeps every legacy row and marks it classified with its old type", async () => {
    const rows = await withClient(legacy.url, (client) =>
      client<{ classification_state: string; canonical_type: string; support_state: string }[]>`
        select classification_state, canonical_type, proposed_type, support_state
        from ontology_entities order by name`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.classification_state)).toEqual(["classified", "classified"]);
    expect(rows.map((row) => row.canonical_type)).toEqual(["SYSTEM", "SYSTEM"]);
    // `supported` would fabricate an evidence judgement nobody ever made.
    expect(rows.map((row) => row.support_state)).toEqual(["uncertain", "uncertain"]);
  });

  it("leaves review state, confidence, properties and pipeline untouched", async () => {
    const rows = await withClient(legacy.url, (client) =>
      client<
        {
          name: string;
          verified: boolean;
          confidence: number;
          properties: unknown;
          source_kind: string;
          pipeline: string;
        }[]
      >`
        select name, verified, confidence, properties, source_kind, pipeline
        from ontology_entities order by id`,
    );
    expect(rows.map((row) => row.verified)).toEqual([true, false]);
    expect(rows.map((row) => Number(row.confidence))).toEqual([0.9, 0.7]);
    expect(rows.map((row) => JSON.stringify(row.properties))).toEqual([
      '{"tier":"edge"}',
      "{}",
    ]);
    expect(rows.map((row) => row.source_kind)).toEqual(["backfeed", "document"]);
    expect(rows.map((row) => row.pipeline)).toEqual(["human-review", "llamaindex-schema-extraction"]);
  });

  it("gives relationships their original predicate as identity, and keeps verified", async () => {
    const rows = await withClient(legacy.url, (client) =>
      client<{ predicate: string; identity_key: string; canonical_type: string; verified: boolean }[]>`
        select predicate, identity_key, canonical_type, verified from ontology_relationships`,
    );
    expect(rows).toEqual([
      { predicate: "USES", identity_key: "uses", canonical_type: "USES", verified: true },
    ]);
  });

  it("keeps case-variant names apart instead of merging them", async () => {
    const keys = await withClient(legacy.url, (client) =>
      client<{ identity_key: string }[]>`
        select identity_key from ontology_entities order by identity_key`,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((row) => row.identity_key)).size).toBe(2);
    expect(keys[0]?.identity_key).toBe("gateway");
    expect(keys[1]?.identity_key).toMatch(/^gateway#[0-9a-f-]{36}$/);
  });
});
