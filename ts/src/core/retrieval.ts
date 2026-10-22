import { sql } from "drizzle-orm";

import type { Database } from "../db.js";

/**
 * Hybrid chunk retrieval with geometric-mean scoring and a recency boost.
 *
 * TypeScript port of `app/core/retrieval.py`. This is the retrieval half of
 * `POST /aks/v1/context`: everything here is one SQL query and **no LLM call**.
 *
 * ## The scoring formula, reproduced verbatim
 *
 * ```
 * vector_sim   = greatest(1 - (embedding <=> query_vec), 0)     -- cosine similarity
 * text_sim     = 0.5               when length(query) < 12       -- short-query fallback
 *              = 0.5               when similarity(content, query) < 0.05
 *              = similarity(content, query)                     -- pg_trgm
 * recency_mult = 0.85 + 0.15 * exp(-age_days / 365)
 * score        = sqrt(vector_sim * text_sim) * recency_mult
 * ```
 *
 * Four properties are worth naming because they are the point of the design:
 *
 * 1. **Geometric mean, not a weighted sum.** `sqrt(a * b)` punishes any chunk
 *    where one signal is weak, so a chunk only ranks highly when semantics *and*
 *    wording agree. A weighted average would let one strong signal carry a chunk
 *    the other signal rejects.
 * 2. **`vector_sim` is clamped at 0.** Cosine similarity of a pgvector `<=>` can
 *    be negative; `greatest(..., 0)` keeps `sqrt` out of NaN territory, and the
 *    clamp therefore changes the ranking of opposing vectors rather than merely
 *    tidying the number.
 * 3. **The two text fallbacks both yield exactly `0.5`** — a neutral value, not
 *    zero and not one. Under 12 characters there are too few trigrams for
 *    `similarity()` to mean anything, and a score below `0.05` is treated as
 *    noise. Both fall back to neutral so trigram similarity cannot drag the
 *    geometric mean to zero on a perfectly good semantic match.
 * 4. **No threshold and no normalisation.** Every embedded chunk in the Stack is
 *    scored; `limit` is the only cut. Nothing rescales the final score, so the
 *    returned `similarity` values are comparable across queries for the same
 *    Stack.
 *
 * ## Ordering is by the raw score, and ties are not broken
 *
 * `order by similarity desc limit N`. Two chunks with identical scores come back
 * in whatever order Postgres produces, exactly as the oracle does — adding a
 * tie-breaker here would silently reorder results the Python server also leaves
 * undefined.
 *
 * ## Why this is raw SQL and not the Drizzle query builder
 *
 * The query needs three things Drizzle's builder cannot express: the pgvector
 * `<=>` cosine-distance operator, the `pg_trgm` `similarity()` function, and a
 * `sqrt`-of-product expression used both in the projection and in `ORDER BY`
 * (hence the CTE). `schema.ts` already keeps the vector and trigram *indexes* as
 * raw SQL for the same reason. Emitting the statement directly also keeps it
 * diffable against `retrieval.py` line by line, which matters more here than
 * builder ergonomics: this is the one place where a quiet change alters which
 * documents answer a question.
 */

/** One scored chunk, as the retrieval query returns it. */
export type RetrievedChunk = {
  id: string;
  content: string;
  document_id: string;
  chunk_index: number;
  /** Final hybrid score: geometric mean of both signals, times recency. */
  similarity: number;
};

/**
 * Renders an embedding as pgvector's text literal: `[0.1,-0.2,...]`.
 *
 * pgvector has no binary/text input type postgres-js recognizes for the `vector`
 * OID, so the value travels as a plain string and is cast in SQL. `String(number)`
 * is the shortest round-trip form JavaScript produces, so no precision is lost
 * relative to the doubles the provider returned.
 *
 * The alternative — binding the JavaScript array and letting Postgres build
 * `ARRAY[...]` — also type-checks as `::vector`, but it makes the driver expand a
 * 768-element parameter list into the statement's bind count for no gain.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((component) => String(component)).join(",")}]`;
}

/**
 * Returns the top-N chunks for a query, ranked by hybrid score.
 *
 * @param stackId resolved Stack id; only chunks belonging to it are considered.
 * @param queryText the user's raw query, used for the trigram signal.
 * @param queryEmbedding the embedding of that same text, from
 *   `embedQuery` in `core/extraction.ts`.
 * @param limit how many chunks to return. `/context` passes 8, matching Python.
 */
export async function retrieveRelevantChunks(
  tx: Database,
  stackId: string,
  queryText: string,
  queryEmbedding: readonly number[],
  limit: number,
): Promise<RetrievedChunk[]> {
  const vector = toVectorLiteral(queryEmbedding);

  // Each `%s` of the Python statement becomes its own bound parameter here, in
  // the same order: vector, query text (length), query text (similarity x3,
  // used for both the comparison and the value), stack id, limit.
  return tx.execute<RetrievedChunk>(sql`
    with scored as (
      select
        dc.id,
        dc.content,
        dc.document_id,
        dc.chunk_index,
        greatest(1 - (dc.embedding <=> ${vector}::vector), 0) as vector_sim,
        case
          when length(${queryText}) < 12 then 0.5
          when similarity(dc.content, ${queryText}) < 0.05 then 0.5
          else similarity(dc.content, ${queryText})
        end as text_sim,
        0.85 + 0.15 * exp(
          -extract(epoch from (now() - dc.created_at)) / (365 * 86400)
        ) as recency_mult
      from document_chunks dc
      where dc.stack_id = ${stackId}
        and dc.embedding is not null
    )
    select
      id, content, document_id, chunk_index,
      sqrt(vector_sim * text_sim) * recency_mult as similarity
    from scored
    order by similarity desc
    limit ${limit}
  `);
}
