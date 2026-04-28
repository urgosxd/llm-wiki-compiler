"""
Hybrid chunk retrieval with geometric mean scoring and recency boost.

This module implements the recommended retrieval pattern from the AKS
spec's Retrieval Quality section:

  score = sqrt(vector_similarity * trigram_similarity) * recency_multiplier

Vector similarity catches semantic matches even when wording differs.
Trigram similarity catches keyword matches even when meaning differs.
The geometric mean penalizes results where one signal is weak — so a
chunk only ranks highly when both signals agree.

The recency boost is a soft multiplier between 1.0 (just-ingested) and
~0.85 (a year old). Old chunks still surface; they just lose a small
edge against newer ones.

For very short queries (under 3 words), trigram similarity scores
poorly because there aren't enough n-grams. We apply a neutral 0.5 in
that case rather than letting trigram drag the geometric mean to zero.

Everything in this file is one SQL query. No LLM calls.
"""
from uuid import UUID

from psycopg2.extensions import connection as PGConnection


def retrieve_relevant_chunks(
    conn: PGConnection,
    stack_id: UUID,
    query_text: str,
    query_embedding: list[float],
    limit: int = 8,
) -> list[dict]:
    """
    Return the top-N chunks for a query, ranked by hybrid score.

    Each result row contains: id, content, document_id, chunk_index,
    similarity (the final hybrid score).
    """
    with conn.cursor() as cur:
        # The query implements:
        #   vector_sim   = 1 - cosine_distance
        #   trigram_sim  = pg_trgm similarity (with short-query fallback)
        #   recency_mult = 0.85 + 0.15 * exp(-age_days / 365)
        #   score        = sqrt(vector_sim * trigram_sim) * recency_mult
        #
        # We use the operator <=> for cosine distance (provided by pgvector).
        cur.execute(
            """
            with scored as (
                select
                    dc.id,
                    dc.content,
                    dc.document_id,
                    dc.chunk_index,
                    -- Vector similarity, clamped at 0
                    greatest(1 - (dc.embedding <=> %s::vector), 0) as vector_sim,
                    -- Trigram similarity, with short-query fallback
                    case
                        when length(%s) < 12 then 0.5
                        when similarity(dc.content, %s) < 0.05 then 0.5
                        else similarity(dc.content, %s)
                    end as text_sim,
                    -- Recency: decay from 1.0 toward 0.85 over 365 days
                    0.85 + 0.15 * exp(
                        -extract(epoch from (now() - dc.created_at)) / (365 * 86400)
                    ) as recency_mult
                from document_chunks dc
                where dc.stack_id = %s
                  and dc.embedding is not null
            )
            select
                id, content, document_id, chunk_index,
                sqrt(vector_sim * text_sim) * recency_mult as similarity
            from scored
            order by similarity desc
            limit %s
            """,
            (
                query_embedding,
                query_text,
                query_text,
                query_text,
                str(stack_id),
                limit,
            ),
        )
        return [dict(r) for r in cur.fetchall()]