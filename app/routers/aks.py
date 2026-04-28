"""
AKS query endpoints.

  GET  /aks/v1/entities             list entities, filterable
  GET  /aks/v1/entities/{name}      fetch single entity
  GET  /aks/v1/traverse             BFS traversal from a starting entity
  POST /aks/v1/context              natural-language query
  GET  /aks/v1/export               full Stack export as AKS Bundle
"""
import json
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.auth import require_api_key
from app.core.database import get_db
from app.core.extraction import embed_query
from app.core.llm_clients import complete
from app.core.aks_serializers import (
    fetch_contributing_documents,
    row_to_entity,
    row_to_relationship,
)
from app.core.retrieval import retrieve_relevant_chunks
from app.core.stack_resolver import resolve_stack
from app.models.api import (
    AKSBundle,
    AKSContextRequest,
    AKSContextResponse,
    AKSDocumentSummary,
    AKSEntity,
    AKSRelationship,
    AKSTraverseResponse,
    AKSTraverseStep,
)


router = APIRouter(
    prefix="/aks/v1",
    tags=["aks"],
    dependencies=[Depends(require_api_key)],
)


# ============================================================
# GET /aks/v1/entities
# ============================================================

@router.get(
    "/entities",
    response_model=list[AKSEntity],
    summary="List entities in a Stack",
)
def list_entities(
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    type: Optional[str] = Query(None, description="Filter by entity type"),
    min_confidence: float = Query(0.0, ge=0.0, le=1.0),
    limit: int = Query(100, ge=1, le=1000),
    conn=Depends(get_db),
) -> list[AKSEntity]:
    """List entities in a Stack with optional type and confidence filters."""
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    sql = """
        select id, name, type, description, properties, confidence,
               verified, last_seen_at, extracted_at, extracted_by_model,
               source_kind, pipeline
        from ontology_entities
        where stack_id = %s
          and confidence >= %s
    """
    params: list = [str(stack["id"]), min_confidence]

    if type:
        sql += " and type = %s"
        params.append(type)

    sql += " order by confidence desc, name limit %s"
    params.append(limit)

    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    if not rows:
        return []

    contrib_map = fetch_contributing_documents(
        conn, [r["id"] for r in rows]
    )
    return [
        row_to_entity(r, contrib_map.get(r["id"], []))
        for r in rows
    ]


# ============================================================
# GET /aks/v1/entities/{name}
# ============================================================

@router.get(
    "/entities/{name}",
    response_model=AKSEntity,
    summary="Get a single entity by name",
)
def get_entity(
    name: str,
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    conn=Depends(get_db),
) -> AKSEntity:
    """Look up a single entity by exact name (case-insensitive)."""
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    with conn.cursor() as cur:
        cur.execute(
            """
            select id, name, type, description, properties, confidence,
                   verified, last_seen_at, extracted_at, extracted_by_model,
                   source_kind, pipeline
            from ontology_entities
            where stack_id = %s and lower(name) = lower(%s)
            """,
            (str(stack["id"]), name),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Entity '{name}' not found in Stack",
        )

    contrib_map = fetch_contributing_documents(conn, [row["id"]])
    return row_to_entity(row, contrib_map.get(row["id"], []))


# ============================================================
# GET /aks/v1/traverse
# ============================================================

@router.get(
    "/traverse",
    response_model=AKSTraverseResponse,
    summary="BFS traversal from a starting entity",
)
def traverse(
    start: str = Query(..., description="Starting entity name"),
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    max_depth: int = Query(2, ge=1, le=5),
    relationship_types: Optional[str] = Query(
        None,
        description="Comma-separated list of relationship types to follow",
    ),
    conn=Depends(get_db),
) -> AKSTraverseResponse:
    """BFS from a named entity, following typed relationships up to max_depth."""
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    with conn.cursor() as cur:
        cur.execute(
            """
            select id, name from ontology_entities
            where stack_id = %s and lower(name) = lower(%s)
            """,
            (str(stack["id"]), start),
        )
        start_row = cur.fetchone()

    if not start_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Entity '{start}' not found in Stack",
        )

    if relationship_types:
        types_list = [t.strip() for t in relationship_types.split(",") if t.strip()]
        sql = """
            with recursive walk as (
                select
                    %s::uuid as current_entity_id,
                    array[%s::uuid] as visited,
                    null::uuid as from_id,
                    null::text as rel_type,
                    null::uuid as to_id,
                    null::real as confidence,
                    0 as depth
                union all
                select
                    r.to_entity_id,
                    w.visited || r.to_entity_id,
                    r.from_entity_id,
                    r.type,
                    r.to_entity_id,
                    r.confidence,
                    w.depth + 1
                from walk w
                join ontology_relationships r
                    on r.from_entity_id = w.current_entity_id
                where r.stack_id = %s
                  and not r.to_entity_id = any(w.visited)
                  and w.depth < %s
                  and r.type = any(%s)
            )
            select
                w.from_id, w.rel_type, w.to_id, w.depth, w.confidence,
                ef.name as from_name, et.name as to_name
            from walk w
            left join ontology_entities ef on ef.id = w.from_id
            left join ontology_entities et on et.id = w.to_id
            where w.from_id is not null
            order by w.depth, ef.name
        """
        params = [
            start_row["id"], start_row["id"],
            str(stack["id"]), max_depth, types_list,
        ]
    else:
        sql = """
            with recursive walk as (
                select
                    %s::uuid as current_entity_id,
                    array[%s::uuid] as visited,
                    null::uuid as from_id,
                    null::text as rel_type,
                    null::uuid as to_id,
                    null::real as confidence,
                    0 as depth
                union all
                select
                    r.to_entity_id,
                    w.visited || r.to_entity_id,
                    r.from_entity_id,
                    r.type,
                    r.to_entity_id,
                    r.confidence,
                    w.depth + 1
                from walk w
                join ontology_relationships r
                    on r.from_entity_id = w.current_entity_id
                where r.stack_id = %s
                  and not r.to_entity_id = any(w.visited)
                  and w.depth < %s
            )
            select
                w.from_id, w.rel_type, w.to_id, w.depth, w.confidence,
                ef.name as from_name, et.name as to_name
            from walk w
            left join ontology_entities ef on ef.id = w.from_id
            left join ontology_entities et on et.id = w.to_id
            where w.from_id is not null
            order by w.depth, ef.name
        """
        params = [
            start_row["id"], start_row["id"],
            str(stack["id"]), max_depth,
        ]

    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    steps = [
        AKSTraverseStep(
            from_entity=r["from_name"],
            relationship=r["rel_type"],
            to_entity=r["to_name"],
            depth=r["depth"],
            confidence=float(r["confidence"]),
        )
        for r in rows
    ]
    distinct_entities = {start_row["name"]}
    for s in steps:
        distinct_entities.add(s.from_entity)
        distinct_entities.add(s.to_entity)

    return AKSTraverseResponse(
        start=start_row["name"],
        max_depth=max_depth,
        steps=steps,
        entity_count=len(distinct_entities),
    )


# ============================================================
# POST /aks/v1/context
# ============================================================

@router.post(
    "/context",
    response_model=AKSContextResponse,
    summary="Natural-language query against a Stack",
)
def context(
    payload: AKSContextRequest,
    conn=Depends(get_db),
) -> AKSContextResponse:
    """
    Pipeline:
      1. Resolve the Stack
      2. Embed the query
      3. Hybrid-retrieve top chunks (no LLM)
      4. ONE LLM call: pick relevant entities from the catalog
      5. Look up those entities and their relationships
      6. Return the subgraph
    """
    stack = resolve_stack(
        conn, stack_id=payload.stack_id, domain=payload.domain
    )
    stack_id = stack["id"]

    query_embedding = embed_query(payload.query)

    chunks = retrieve_relevant_chunks(
        conn=conn,
        stack_id=stack_id,
        query_text=payload.query,
        query_embedding=query_embedding,
        limit=8,
    )

    if not chunks:
        return AKSContextResponse(
            query=payload.query,
            entities=[],
            relationships=[],
            traversal_path=[],
            reasoning="No relevant chunks found in the Stack.",
            confidence="LOW",
            source_type="compiled",
        )

    with conn.cursor() as cur:
        cur.execute(
            """
            select name, type
            from ontology_entities
            where stack_id = %s
            order by confidence desc
            limit 200
            """,
            (str(stack_id),),
        )
        catalog = cur.fetchall()

    if not catalog:
        return AKSContextResponse(
            query=payload.query,
            entities=[],
            relationships=[],
            traversal_path=[],
            reasoning="Stack has no compiled entities yet.",
            confidence="LOW",
            source_type="compiled",
        )

    chunk_text = "\n\n---\n\n".join(c["content"] for c in chunks)
    catalog_text = "\n".join(f"- {e['name']} ({e['type']})" for e in catalog)

    prompt = f"""You are helping route a query to relevant entities in a knowledge graph.

The user's query:
{payload.query}

The most semantically relevant passages from the source documents:
{chunk_text}

The compiled entities available in this domain:
{catalog_text}

Identify the entities from the catalog above that are most relevant to answering
the query. Return a JSON object with this exact shape:

{{
  "entity_names": ["Name1", "Name2", ...],
  "reasoning": "Brief explanation of why these entities are relevant",
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}}

Return at most {payload.max_entities} entity names. Use exact names from
the catalog. Confidence is HIGH when the passages clearly answer the query
through these entities, MEDIUM when partial coverage, LOW when the Stack
appears thin on this topic.

Return ONLY the JSON object, no other text."""

    raw = complete(prompt, max_tokens=1024)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return AKSContextResponse(
            query=payload.query,
            entities=[],
            relationships=[],
            traversal_path=[],
            reasoning="LLM returned malformed entity selection.",
            confidence="LOW",
            source_type="compiled",
        )

    selected_names = [n.strip() for n in parsed.get("entity_names", [])]
    reasoning = parsed.get("reasoning", "")
    conf = parsed.get("confidence", "LOW").upper()
    if conf not in ("HIGH", "MEDIUM", "LOW"):
        conf = "LOW"

    if not selected_names:
        return AKSContextResponse(
            query=payload.query,
            entities=[],
            relationships=[],
            traversal_path=[],
            reasoning=reasoning or "No relevant entities identified.",
            confidence="LOW",
            source_type="compiled",
        )

    with conn.cursor() as cur:
        cur.execute(
            """
            select id, name, type, description, properties, confidence,
                   verified, last_seen_at, extracted_at, extracted_by_model,
                   source_kind, pipeline
            from ontology_entities
            where stack_id = %s
              and lower(name) = any(%s::text[])
            """,
            (str(stack_id), [n.lower() for n in selected_names]),
        )
        entity_rows = cur.fetchall()

    if not entity_rows:
        return AKSContextResponse(
            query=payload.query,
            entities=[],
            relationships=[],
            traversal_path=selected_names,
            reasoning=reasoning,
            confidence="LOW",
            source_type="compiled",
        )

    entity_ids = [r["id"] for r in entity_rows]

    relationships: list[AKSRelationship] = []
    if payload.include_relationships:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, from_entity_id, to_entity_id, type, description,
                       confidence, verified, extracted_at, extracted_by_model,
                       source_kind, pipeline
                from ontology_relationships
                where stack_id = %s
                  and from_entity_id = any(%s::uuid[])
                  and to_entity_id = any(%s::uuid[])
                """,
                (
                    str(stack_id),
                    [str(eid) for eid in entity_ids],
                    [str(eid) for eid in entity_ids],
                ),
            )
            relationships = [row_to_relationship(r) for r in cur.fetchall()]

    contrib_map = fetch_contributing_documents(conn, entity_ids)
    entities = [
        row_to_entity(r, contrib_map.get(r["id"], []))
        for r in entity_rows
    ]

    return AKSContextResponse(
        query=payload.query,
        entities=entities,
        relationships=relationships,
        traversal_path=[r["name"] for r in entity_rows],
        reasoning=reasoning,
        confidence=conf,
        source_type="compiled",
    )


# ============================================================
# GET /aks/v1/export
# ============================================================

@router.get(
    "/export",
    response_model=AKSBundle,
    summary="Export the full Stack as an AKS Bundle",
)
def export_bundle(
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    min_confidence: float = Query(0.0, ge=0.0, le=1.0),
    verified_only: bool = Query(False),
    entity_type: Optional[str] = Query(None),
    conn=Depends(get_db),
) -> AKSBundle:
    """Export the full Stack as an AKS Bundle."""
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    sql = """
        select id, name, type, description, properties, confidence,
               verified, last_seen_at, extracted_at, extracted_by_model,
               source_kind, pipeline
        from ontology_entities
        where stack_id = %s
          and confidence >= %s
    """
    params: list = [str(stack["id"]), min_confidence]
    if verified_only:
        sql += " and verified = true"
    if entity_type:
        sql += " and type = %s"
        params.append(entity_type)

    with conn.cursor() as cur:
        cur.execute(sql, params)
        entity_rows = cur.fetchall()

    entity_ids = [r["id"] for r in entity_rows]

    relationship_rows: list[dict] = []
    if entity_ids:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, from_entity_id, to_entity_id, type, description,
                       confidence, verified, extracted_at, extracted_by_model,
                       source_kind, pipeline
                from ontology_relationships
                where stack_id = %s
                  and from_entity_id = any(%s::uuid[])
                  and to_entity_id = any(%s::uuid[])
                """,
                (
                    str(stack["id"]),
                    [str(eid) for eid in entity_ids],
                    [str(eid) for eid in entity_ids],
                ),
            )
            relationship_rows = cur.fetchall()

    document_rows: list[dict] = []
    with conn.cursor() as cur:
        cur.execute(
            """
            select distinct sd.id, sd.filename, sd.ingested_at,
                   sd.source_hash, sd.truncated, sd.original_length, sd.audit
            from stack_documents sd
            where sd.stack_id = %s
            order by sd.ingested_at desc
            """,
            (str(stack["id"]),),
        )
        document_rows = cur.fetchall()

    contrib_map = fetch_contributing_documents(conn, entity_ids)

    return AKSBundle(
        aks_version="0.2.0",
        domain=stack["domain"],
        stack_id=stack["id"],
        stack_name=stack["name"],
        compiled_at=datetime.now(timezone.utc),
        scope=stack["scope"],
        entity_count=len(entity_rows),
        relationship_count=len(relationship_rows),
        document_count=len(document_rows),
        compilation_strategy=stack.get("compilation_strategy"),
        documents=[
            AKSDocumentSummary(
                id=d["id"],
                filename=d["filename"],
                ingested_at=d["ingested_at"],
                source_hash=d["source_hash"],
                truncated=d["truncated"],
                original_length=d["original_length"],
                audit=d.get("audit"),
            )
            for d in document_rows
        ],
        entities=[
            row_to_entity(r, contrib_map.get(r["id"], []))
            for r in entity_rows
        ],
        relationships=[row_to_relationship(r) for r in relationship_rows],
    )
