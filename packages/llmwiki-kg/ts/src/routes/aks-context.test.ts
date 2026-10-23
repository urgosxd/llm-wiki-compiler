/**
 * @file packages/llmwiki-kg/ts/src/routes/aks-context.test.ts
 * @description `/aks/v1/context` with the LLM stubbed.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { retrieveRelevantChunks, toVectorLiteral } from "../core/retrieval.js";
import { createFixture, database, deleteFixtureRows, oppositeVector, orthogonallyMixed, state, unitVector, useDomainPrefix } from "./aks-harness.js";
import type { Fixture } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("context");

/**
 * Retrieval scoring, exercised without the gateway.
 *
 * Vectors are written directly, so every expected score is computable from the
 * formula rather than observed from a model: this is the only way to pin the
 * geometric mean, the two 0.5 text fallbacks and the recency multiplier without
 * spending a provider call.
 */
describe.skipIf(state.skipReason !== false)(
  "hybrid retrieval scoring (no gateway)",
  () => {
    beforeEach(async () => {
      await deleteFixtureRows();
    });

    afterAll(async () => {
      await deleteFixtureRows();
    });

    /** Writes one chunk with an explicit embedding, returning its id. */
    async function createChunk(
      fixture: Fixture,
      content: string,
      embedding: readonly number[],
      chunkIndex: number,
      ageDays = 0,
    ): Promise<string> {
      const chunkId = randomUUID();
      await database().execute(sql`
        insert into document_chunks (
          id, document_id, stack_id, chunk_index, content, content_hash,
          token_count, embedding, created_at
        )
        values (
          ${chunkId}, ${fixture.documentId}, ${fixture.stackId}, ${chunkIndex},
          ${content}, ${`hash-${chunkId}`}, ${10},
          ${toVectorLiteral(embedding)}::vector,
          now() - (${ageDays} * interval '1 day')
        )
      `);
      return chunkId;
    }

    it("renders pgvector literals the way Postgres reads them", () => {
      expect(toVectorLiteral([0.1, -0.2, 0])).toBe("[0.1,-0.2,0]");
      expect(toVectorLiteral([])).toBe("[]");
    });

    it("ranks a chunk that matches both signals above one that matches only one", async () => {
      const fixture = await createFixture();
      // Query text is long enough (>= 12 chars) to use trigram similarity.
      const query = "gateway routes embedding traffic";
      const [qa, qb] = await Promise.all([
        // Aligned with the query vector and sharing vocabulary.
        createChunk(fixture, `${query} through the nomic model`, unitVector(0), 0),
        // Aligned with the query vector but sharing no trigrams.
        createChunk(fixture, "zzzz wwwww qqqqq vvvvv", unitVector(0), 1),
      ]);
      // Orthogonal to the query vector but sharing vocabulary.
      const c = await createChunk(fixture, `${query} through the nomic model`, unitVector(1), 2);
      expect(c).not.toBe(qa);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const order = chunks.map((chunk) => chunk.id);
      expect(order[0]).toBe(qa);
      expect(order).toContain(qb);
      // The orthogonal chunk has vector_sim clamped to 0, so its score is 0.
      expect(chunks.find((chunk) => chunk.id === qb)?.similarity).toBeGreaterThan(0);
    });

    it("clamps negative cosine similarity to zero instead of producing NaN", async () => {
      const fixture = await createFixture();
      const query = "opposing vector chunk";
      const id = await createChunk(fixture, query, oppositeVector(0), 0);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const found = chunks.find((chunk) => chunk.id === id);
      expect(found).toBeDefined();
      expect(Number.isNaN(found?.similarity ?? Number.NaN)).toBe(false);
      expect(found?.similarity).toBe(0);
    });

    it("applies the neutral 0.5 trigram fallback for a short query", async () => {
      const fixture = await createFixture();
      // Under 12 characters, so `text_sim` is exactly 0.5.
      const query = "gateway";
      const chunkId = await createChunk(fixture, "unrelated content entirely", unitVector(0), 0);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const found = chunks.find((chunk) => chunk.id === chunkId);
      // vector_sim ~= 1, text_sim == 0.5, recency ~= 1 -> sqrt(0.5) ~= 0.7071.
      expect(found?.similarity).toBeCloseTo(Math.sqrt(0.5), 3);
    });

    it("applies the same 0.5 fallback when trigram similarity is below 0.05", async () => {
      const fixture = await createFixture();
      // A long query with no trigram overlap at all: similarity() would be ~0.
      const query = "completely dissimilar phrasing here";
      const chunkId = await createChunk(fixture, "xxxxxxxx yyyyyyyy", unitVector(0), 0);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const found = chunks.find((chunk) => chunk.id === chunkId);
      expect(found?.similarity).toBeCloseTo(Math.sqrt(0.5), 3);
    });

    it("multiplies by the recency factor, so an older chunk scores lower", async () => {
      const fixture = await createFixture();
      const query = "recency comparison chunk";
      const fresh = await createChunk(fixture, query, unitVector(0), 0, 0);
      const old = await createChunk(fixture, query, unitVector(0), 1, 365);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const freshScore = chunks.find((chunk) => chunk.id === fresh)?.similarity ?? 0;
      const oldScore = chunks.find((chunk) => chunk.id === old)?.similarity ?? 0;

      expect(freshScore).toBeGreaterThan(oldScore);
      // One year of decay: 0.85 + 0.15 * e^-1, versus ~1.0 when brand new.
      const ratio = oldScore / freshScore;
      expect(ratio).toBeCloseTo(0.85 + 0.15 * Math.exp(-1), 2);
    });

    it("scopes the search to one Stack and skips chunks with no embedding", async () => {
      const mine = await createFixture();
      const other = await createFixture();
      const mineId = await createChunk(mine, "scoped retrieval chunk", unitVector(0), 0);
      await createChunk(other, "scoped retrieval chunk", unitVector(0), 0);

      // A NULL embedding is excluded by `where dc.embedding is not null`.
      await database().execute(sql`
        insert into document_chunks (
          id, document_id, stack_id, chunk_index, content, content_hash, token_count
        )
        values (
          ${randomUUID()}, ${mine.documentId}, ${mine.stackId}, 9,
          ${"no embedding here"}, ${randomUUID()}, ${3}
        )
      `);

      const chunks = await retrieveRelevantChunks(
        database(),
        mine.stackId,
        "scoped retrieval chunk",
        unitVector(0),
        10,
      );

      expect(chunks.map((chunk) => chunk.id)).toEqual([mineId]);
    });

    it("honours the limit and returns the highest scores first", async () => {
      const fixture = await createFixture();
      const query = "ordering check chunk";
      const a = await createChunk(fixture, query, unitVector(0), 0);
      const b = await createChunk(fixture, query, unitVector(0), 1, 365);
      const c = await createChunk(fixture, query, orthogonallyMixed(), 2);

      const all = await retrieveRelevantChunks(database(), fixture.stackId, query, unitVector(0), 10);
      expect(all).toHaveLength(3);

      const top = await retrieveRelevantChunks(database(), fixture.stackId, query, unitVector(0), 2);
      expect(top).toHaveLength(2);
      // Fresh, then stale, then the weakly-aligned one.
      expect([top[0]?.id, top[1]?.id]).toEqual([a, b]);
      expect(all.some((chunk) => chunk.id === c)).toBe(true);
      // Scores are non-increasing.
      for (let index = 1; index < all.length; index += 1) {
        const previous = all[index - 1]?.similarity ?? 0;
        const current = all[index]?.similarity ?? 0;
        expect(previous).toBeGreaterThanOrEqual(current);
      }
    });
  },
);
