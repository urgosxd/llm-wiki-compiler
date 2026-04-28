"""
Ingestion endpoint.

Pipeline:
  1. Verify the document exists and belongs to the specified Stack
  2. Read the file from disk and decode as UTF-8 text
  3. Apply the extraction-time character limit
  4. Call extraction.chunk_and_embed
  5. Persist chunks into document_chunks
  6. Call extraction.extract_graph_from_chunks
  7. Optionally call synthesize_entity_descriptions (off by default)
  8. Call consolidation.consolidate_entities
  9. Call consolidation.consolidate_relationships
  10. Return a summary

Description synthesis is opt-in via either:
  - The Stack's synthesize_descriptions setting (column on stacks table)
  - The ?synthesize_descriptions=true|false query param (overrides stack default)
"""

from pathlib import Path
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import require_api_key
from app.core.consolidation import consolidate_entities, consolidate_relationships
from app.core.constants import MAX_EXTRACTION_CHARS
from app.core.database import get_db
from app.core.extraction import (
    chunk_and_embed,
    extract_graph_from_chunks,
    synthesize_entity_descriptions,
)


router = APIRouter(
    tags=["ingestion"],
    dependencies=[Depends(require_api_key)],
)


class IngestionResult(BaseModel):
    document_id: UUID
    chunks_created: int
    entities_extracted: int
    entities_in_stack: int
    relationships_extracted: int
    relationships_written: int
    relationships_in_stack: int
    truncated: bool
    descriptions_synthesized: bool


@router.post(
    "/stacks/{stack_id}/documents/{doc_id}/ingest",
    response_model=IngestionResult,
    summary="Run the compilation pipeline on an uploaded document",
)
def ingest_document(
    stack_id: UUID,
    doc_id: UUID,
    synthesize_descriptions: Optional[bool] = Query(
        None,
        description=(
            "Override the Stack's default for description synthesis. "
            "If omitted, uses the Stack's setting. If true, runs the "
            "synthesis pass (one extra LLM call per extracted entity)."
        ),
    ),
    conn=Depends(get_db),
) -> IngestionResult:
    """
    Compile an uploaded document into the Stack's ontology.
    Idempotent: re-ingesting the same document updates confidence values
    and last_seen_at timestamps but does not create duplicates.
    """

    # ----- 1. Verify the document exists and resolve the Stack name -----
    with conn.cursor() as cur:
        cur.execute(
            """
            select sd.id, sd.stack_id, sd.storage_path, sd.truncated,
                   s.name as stack_name,
                   s.synthesize_descriptions as stack_synthesize_default
            from stack_documents sd
            join stacks s on s.id = sd.stack_id
            where sd.id = %s and sd.stack_id = %s
            """,
            (str(doc_id), str(stack_id)),
        )
        doc = cur.fetchone()

    if not doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document {doc_id} not found in Stack {stack_id}",
        )

    # ----- 2. Load the file from disk and decode -----
    storage_path = Path(doc["storage_path"])
    if not storage_path.exists():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Document file is missing on disk",
        )

    try:
        raw = storage_path.read_bytes()
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                "Document is not UTF-8 text. Binary format support "
                "(PDF, DOCX) is planned for a later release."
            ),
        )

    # ----- 3. Apply extraction-time truncation. The on-disk file stays full. -----
    was_truncated = len(text) > MAX_EXTRACTION_CHARS
    if was_truncated:
        text = text[:MAX_EXTRACTION_CHARS]

    # ----- 4. Chunk and embed -----
    chunks = chunk_and_embed(
        text=text,
        stack_id=stack_id,
        document_id=doc_id,
    )

    # ----- 5. Persist chunks. ON CONFLICT DO UPDATE handles re-ingestion. -----
    with conn.cursor() as cur:
        for chunk in chunks:
            cur.execute(
                """
                insert into document_chunks (
                    document_id, stack_id, chunk_index, content,
                    content_hash, token_count, embedding, chunker_strategy
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (document_id, chunk_index) do update set
                    content = excluded.content,
                    content_hash = excluded.content_hash,
                    token_count = excluded.token_count,
                    embedding = excluded.embedding
                """,
                (
                    str(chunk.document_id),
                    str(chunk.stack_id),
                    chunk.chunk_index,
                    chunk.content,
                    chunk.content_hash,
                    chunk.token_count,
                    chunk.embedding,
                    chunk.chunker_strategy,
                ),
            )

    # ----- 6. Extract entities and relationships -----
    extraction = extract_graph_from_chunks(
        chunks=chunks,
        stack_name=doc["stack_name"],
    )

    # ----- 7. Optionally synthesize rich descriptions -----
    # Per-call override wins; otherwise use the Stack's default.
    should_synthesize = (
        synthesize_descriptions
        if synthesize_descriptions is not None
        else doc["stack_synthesize_default"]
    )
    if should_synthesize:
        synthesize_entity_descriptions(extraction, chunks)

    # ----- 8. Consolidate entities, getting name -> UUID map -----
    name_to_id = consolidate_entities(
        conn=conn,
        stack_id=stack_id,
        document_id=doc_id,
        extracted=extraction.entities,
    )

    # ----- 9. Consolidate relationships using the map -----
    rels_written = consolidate_relationships(
        conn=conn,
        stack_id=stack_id,
        extracted=extraction.relationships,
        name_to_id=name_to_id,
    )

    # ----- 10. Tally results for the response -----
    with conn.cursor() as cur:
        cur.execute(
            "select count(*) as n from ontology_entities where stack_id = %s",
            (str(stack_id),),
        )
        total_entities = cur.fetchone()["n"]

        cur.execute(
            "select count(*) as n from ontology_relationships where stack_id = %s",
            (str(stack_id),),
        )
        total_rels = cur.fetchone()["n"]

    return IngestionResult(
        document_id=doc_id,
        chunks_created=len(chunks),
        entities_extracted=len(extraction.entities),
        entities_in_stack=total_entities,
        relationships_extracted=len(extraction.relationships),
        relationships_written=rels_written,
        relationships_in_stack=total_rels,
        truncated=was_truncated,
        descriptions_synthesized=should_synthesize,
    )
