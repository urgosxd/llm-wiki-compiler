/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-gateway.test.ts
 * @description The live-gateway context call, enabled only with `AKS_TEST_GATEWAY=1`.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { CONTEXT_KEYS, ENTITY_KEYS, RELATIONSHIP_KEYS, useDomainPrefix } from "./aks-harness.js";

import type { Express } from "express";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { toVectorLiteral } from "../core/retrieval.js";
import { createFixture, createTestApp, database, deleteFixtureRows, state } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("gateway");

/**
 * The one block that spends money.
 *
 * Enabled only with `AKS_TEST_GATEWAY=1`. One `/context` request: an embedding
 * for the query plus one extraction completion, which is the minimum needed to
 * exercise the full pipeline against a real provider.
 *
 * Nothing LLM-derived is asserted as an exact value — measured on the oracle,
 * three identical requests returned 5, 3 and 4 entities. What is asserted is the
 * envelope: key set, field types, the confidence vocabulary, and that every
 * returned entity really belongs to the fixture Stack.
 */
describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")(
  "aks context (live gateway)",
  () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
    });

    afterAll(async () => {
      await deleteFixtureRows();
    });

    it("returns a structurally valid subgraph for a natural-language query", async () => {
      const fixture = await createFixture();
      // Chunks are needed for the pipeline to reach the LLM at all: with no
      // chunks the endpoint short-circuits before calling the model. The
      // embedding comes from the gateway, which is the whole point of this block.
      const { embedQuery } = await import("../core/extraction.js");
      const embedding = await embedQuery("How does the gateway route embedding traffic?");
      expect(embedding).toHaveLength(768);

      await database().execute(sql`
        insert into document_chunks (
          id, document_id, stack_id, chunk_index, content, content_hash,
          token_count, embedding
        )
        values (
          ${randomUUID()}, ${fixture.documentId}, ${fixture.stackId}, 0,
          ${"The gateway routes embedding traffic to the Nomic embedding model, which caps throughput with a rate limit."},
          ${randomUUID()}, ${24}, ${toVectorLiteral(embedding)}::vector
        )
      `);

      const response = await request(app)
        .post("/aks/v1/context")
        .send({ domain: fixture.domain, query: "How does the gateway route embedding traffic?" })
        .expect(200);

      expect(Object.keys(response.body as object)).toEqual([...CONTEXT_KEYS]);

      const body = response.body as {
        query: string;
        entities: Array<Record<string, unknown>>;
        relationships: Array<Record<string, unknown>>;
        traversal_path: string[];
        reasoning: string;
        confidence: string;
        source_type: string;
      };

      expect(body.query).toBe("How does the gateway route embedding traffic?");
      expect(typeof body.reasoning).toBe("string");
      expect(["HIGH", "MEDIUM", "LOW"]).toContain(body.confidence);
      expect(body.source_type).toBe("compiled");
      expect(Array.isArray(body.entities)).toBe(true);
      expect(Array.isArray(body.relationships)).toBe(true);
      expect(Array.isArray(body.traversal_path)).toBe(true);

      // Structure only: the count is model-dependent and must never be pinned.
      for (const entity of body.entities) {
        expect(Object.keys(entity)).toEqual([...ENTITY_KEYS]);
        expect(typeof entity["confidence"]).toBe("number");
      }
      for (const relationship of body.relationships) {
        expect(Object.keys(relationship)).toEqual([...RELATIONSHIP_KEYS]);
      }

      // Whatever the model selected, it can only be a fixture entity, and the
      // trajectory names must be real rows.
      const fixtureNames = ["Gateway", "Embedding Model", "Rate Limit"];
      for (const entity of body.entities) {
        expect(fixtureNames).toContain(entity["name"]);
      }
      for (const name of body.traversal_path) {
        expect(typeof name).toBe("string");
      }
      expect(body.traversal_path).toEqual(body.entities.map((entity) => entity["name"]));
    }, 180_000);
  },
);
