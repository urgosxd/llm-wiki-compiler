/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-gateway.test.ts
 * @description The live-gateway ingest, enabled only with `AKS_TEST_GATEWAY=1`.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { RESPONSE_KEYS, useDomainPrefix } from "./ingest-harness.js";

import { sql } from "drizzle-orm";
import { createDocument, createStack, createTestApp, database, deleteFixtureRows, ingestUrl, state } from "./ingest-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("gateway");

/**
 * The one block that spends money.
 *
 * Enabled only with `AKS_TEST_GATEWAY=1`, so an ordinary `npm test` (including
 * the 420 pre-existing tests) never calls a provider. When enabled it ingests one
 * small document twice, which is the minimum needed to observe the consolidation
 * contract: `relationships_written` counts attempts and stays flat, while
 * `relationships_in_stack` reflects real row growth.
 */
describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")(
  "ingest (live gateway)",
  () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
    });

    afterEach(async () => {
      await deleteFixtureRows();
    });

    it("ingests a document and re-ingests it without duplicating rows", async () => {
      const stackId = await createStack();
      const documentId = await createDocument(
        stackId,
        "The gateway routes embedding traffic for the extraction pipeline. " +
          "Nomic Embed produces vectors for every chunk.\n\n" +
          "The gateway also enforces rate limits for the extraction pipeline.",
      );

      const first = await request(app).post(ingestUrl(stackId, documentId)).expect(200);
      expect(Object.keys(first.body)).toEqual([...RESPONSE_KEYS]);
      expect(first.body.document_id).toBe(documentId);
      expect(first.body.truncated).toBe(false);
      expect(first.body.descriptions_synthesized).toBe(false);
      // At least one chunk was embedded and stored.
      expect(first.body.chunks_created).toBeGreaterThanOrEqual(1);

      const second = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

      // The consolidation contract: the chunk count is stable (the upsert
      // rewrites in place), and the entity total does not grow, while the
      // relationship total may grow because a second run can extract an edge the
      // first did not. `relationships_written` counts attempts, so it is
      // whatever the second run extracted.
      expect(second.body.chunks_created).toBe(first.body.chunks_created);
      expect(second.body.entities_in_stack).toBe(first.body.entities_in_stack);

      // Stored rows prove no duplication: one chunk per index, one entity per
      // name, no duplicate edges.
      const chunkRows = await database().execute<{ chunk_index: number }>(sql`
        select chunk_index from document_chunks
        where document_id = ${documentId} order by chunk_index
      `);
      expect(chunkRows.map((row) => row.chunk_index)).toEqual(
        chunkRows.map((_, index) => index),
      );

      const duplicates = await database().execute<{ n: number }>(sql`
        select count(*)::int as n from (
          select lower(name) from ontology_entities
          where stack_id = ${stackId}
          group by lower(name) having count(*) > 1
        ) as dupes
      `);
      expect(duplicates[0]?.n).toBe(0);

      const edgeDuplicates = await database().execute<{ n: number }>(sql`
        select count(*)::int as n from (
          select from_entity_id, to_entity_id, type from ontology_relationships
          where stack_id = ${stackId}
          group by from_entity_id, to_entity_id, type having count(*) > 1
        ) as dupes
      `);
      expect(edgeDuplicates[0]?.n).toBe(0);

      // Every chunk carries a 768-dimension vector and a real token count.
      const chunks = await database().execute<{ dims: number; token_count: number }>(sql`
        select vector_dims(embedding) as dims, token_count
        from document_chunks where document_id = ${documentId}
      `);
      for (const row of chunks) {
        expect(row.dims).toBe(768);
        expect(row.token_count).toBeGreaterThan(0);
      }
    }, 180_000);
  },
);
