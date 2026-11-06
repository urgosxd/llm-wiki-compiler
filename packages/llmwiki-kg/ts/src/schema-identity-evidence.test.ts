/**
 * @file packages/llmwiki-kg/ts/src/schema-identity-evidence.test.ts
 * @description What the open-classification schema ALLOWS, once it is applied.
 *
 * The migration's own behaviour is asserted in `schema-open-classification.test.ts`;
 * this file is the other half of the contract, driven through the same public SQL
 * surface on the fully-migrated database:
 *
 * - an identity key, not a spelling, decides what is the same entity, so homonyms are
 *   two rows and two different free predicates between the same endpoints are two
 *   edges;
 * - the upsert the consolidators run still resolves, which is why
 *   `unique_edge_per_stack` was kept beside the identity key;
 * - `kg_evidence` and `kg_classification_log` accept the shapes they were created for
 *   and reject the ones they were not.
 *
 * Every rejected insert also proves the counters did not move: a constraint that
 * throws after a partial write is a different bug from one that refuses the row.
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  freshDatabaseUrl,
  newStack,
  twoEntities,
} from "./schema-open-classification-harness.js";
import { withClient } from "./testing/per-run-database.js";

describe("identity keys", () => {
  it("derives one for a writer that does not name the column", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await newStack(client, "identity-derive");
      await twoEntities(client, stackId, ["Billing Service", "Payment Gateway"]);
      const keys = await client<{ name: string; identity_key: string }[]>`
        select name, identity_key from ontology_entities
        where stack_id = ${stackId} order by name`;
      expect(keys).toEqual([
        { name: "Billing Service", identity_key: "billing service" },
        { name: "Payment Gateway", identity_key: "payment gateway" },
      ]);
    });
  });

  it("keeps homonyms apart and rejects a repeated identity key", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await newStack(client, "identity-homonyms");
      await client`
        insert into ontology_entities (stack_id, name, type, identity_key) values
          (${stackId}, 'Jordan', 'ROLE', 'jordan:employee-42'),
          (${stackId}, 'Jordan', 'ROLE', 'jordan:employee-99')`;
      await expect(
        client`insert into ontology_entities (stack_id, name, type, identity_key)
          values (${stackId}, 'Jordan', 'ROLE', 'jordan:employee-42')`,
      ).rejects.toThrow(/duplicate key value/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from ontology_entities where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(2);
    });
  });

  it("keeps two different free predicates apart between the same endpoints", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await newStack(client, "identity-predicates");
      const [from, to] = await twoEntities(client, stackId, ["Policy A", "Process B"]);
      await client`
        insert into ontology_relationships
          (stack_id, from_entity_id, to_entity_id, type, identity_key) values
          (${stackId}, ${from}, ${to}, 'deja sin efecto', 'deja sin efecto'),
          (${stackId}, ${from}, ${to}, 'revoca', 'revoca')`;
      await expect(
        client`insert into ontology_relationships
          (stack_id, from_entity_id, to_entity_id, type, identity_key)
          values (${stackId}, ${from}, ${to}, 'deja sin efecto', 'deja sin efecto')`,
      ).rejects.toThrow(/duplicate key value/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from ontology_relationships where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(2);
      const predicates = await client<{ predicate: string | null }[]>`
        select predicate from ontology_relationships where stack_id = ${stackId} order by type`;
      expect(predicates.map((row) => row.predicate)).toEqual(["deja sin efecto", "revoca"]);
    });
  });

  it("still resolves the edge upsert the consolidators run", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await newStack(client, "identity-edge-upsert");
      const [from, to] = await twoEntities(client, stackId, ["System C", "Role D"]);
      for (const confidence of [0.7, 0.9]) {
        await client`
          insert into ontology_relationships
            (stack_id, from_entity_id, to_entity_id, type, confidence)
          values (${stackId}, ${from}, ${to}, 'supports', ${confidence})
          on conflict (stack_id, from_entity_id, to_entity_id, type)
          do update set confidence = greatest(
            ontology_relationships.confidence, excluded.confidence)`;
      }
      const rows = await client<{ count: number; confidence: number }[]>`
        select count(*)::int as count, max(confidence)::float8 as confidence
        from ontology_relationships where stack_id = ${stackId}`;
      expect(rows[0]?.count).toBe(1);
      // `real` storage rounds: 0.9 comes back as 0.8999999761581421.
      expect(rows[0]?.confidence).toBeCloseTo(0.9, 6);
    });
  });
});

describe("evidence and classification history", () => {
  /** A stack, a document and a chunk to hang evidence off. */
  async function provenanceStack(client: Sql, slug: string): Promise<string> {
    const stackId = await newStack(client, slug);
    const documents = await client<{ id: string }[]>`
      insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
      values (${stackId}, 'policy.md', 'policy.md', 12, ${`hash-${slug}`}) returning id`;
    const documentId = documents[0]?.id;
    if (documentId === undefined) throw new Error("document insert returned no row");
    await client`
      insert into document_chunks (document_id, stack_id, chunk_index, content, content_hash)
      values (${documentId}, ${stackId}, 0, 'Deja sin efecto la política anterior.',
        ${`chunk-${slug}`})`;
    return stackId;
  }

  it("records provenance for a candidate source span", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await provenanceStack(client, "evidence-provenance");
      const chunk = await client<{ id: string; document_id: string }[]>`
        select id, document_id from document_chunks where stack_id = ${stackId} limit 1`;
      const chunkId = chunk[0]?.id;
      const documentId = chunk[0]?.document_id;
      if (chunkId === undefined || documentId === undefined) {
        throw new Error("chunk insert returned no row");
      }
      await client`
        insert into kg_evidence
          (stack_id, candidate_kind, candidate_ref, document_id, chunk_id, chunk_index,
           evidence_text, char_start, char_end, normalized_match, evidence_kind,
           model, pipeline_version, catalog_version)
        values (${stackId}, 'relationship', 'deja_sin_efecto', ${documentId}, ${chunkId}, 0,
          'Deja sin efecto la política anterior.', 0, 37, true, 'textual',
          'model-a', 'pipeline-1', '1.0.0')`;
      const rows = await client<
        { candidate_kind: string; evidence_kind: string; chunk_index: number }[]
      >`select candidate_kind, evidence_kind, chunk_index from kg_evidence
        where stack_id = ${stackId}`;
      expect(rows).toEqual([
        { candidate_kind: "relationship", evidence_kind: "textual", chunk_index: 0 },
      ]);
    });
  });

  it("rejects an evidence kind or an inverted offset span", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await provenanceStack(client, "evidence-rejects");
      const documentId = (
        await client<{ id: string }[]>`select id from stack_documents where stack_id = ${stackId}`
      )[0]?.id;
      if (documentId === undefined) throw new Error("document insert returned no row");
      await expect(
        client`insert into kg_evidence
          (stack_id, candidate_kind, candidate_ref, document_id, evidence_text, evidence_kind)
          values (${stackId}, 'entity', 'cand-1', ${documentId}, 'quote', 'guess')`,
      ).rejects.toThrow(/valid_evidence_kind/);
      await expect(
        client`insert into kg_evidence
          (stack_id, candidate_kind, candidate_ref, document_id, evidence_text,
           char_start, char_end)
          values (${stackId}, 'entity', 'cand-2', ${documentId}, 'quote', 10, 4)`,
      ).rejects.toThrow(/valid_evidence_offsets/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from kg_evidence where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(0);
    });
  });

  it("records a classification transition and rejects an unknown state", async () => {
    await withClient(freshDatabaseUrl(), async (client) => {
      const stackId = await newStack(client, "classification-log");
      await client`
        insert into kg_classification_log
          (stack_id, candidate_kind, candidate_ref, previous_state, new_state,
           previous_canonical_type, new_canonical_type, jev_choice, jev_confidence,
           catalog_version, classifier_version, reason)
        values (${stackId}, 'entity', 'billing-service', 'free_no_match', 'classified',
          null, 'Process', 'Process', 0.91, '1.0.0', 'jev-2026-09', 'catalog gained Process')`;
      await expect(
        client`insert into kg_classification_log
          (stack_id, candidate_kind, candidate_ref, new_state)
          values (${stackId}, 'entity', 'cand-2', 'probably_fine')`,
      ).rejects.toThrow(/valid_log_new_state/);
      const counted = await client<{ count: number }[]>`
        select count(*)::int as count from kg_classification_log where stack_id = ${stackId}`;
      expect(counted[0]?.count).toBe(1);
    });
  });
});
