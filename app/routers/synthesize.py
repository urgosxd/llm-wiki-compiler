"""
Backfill description synthesis for entities that already exist.

Two endpoints:
  POST /stacks/{stack_id}/synthesize-descriptions       backfill many at once
  POST /aks/v1/entities/{name}/synthesize-description   backfill one

Both are opt-in. Useful when a Stack was ingested without synthesis
and a user now wants rich descriptions, or when descriptions need to
be regenerated after the Stack has grown.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import require_api_key
from app.core.database import get_db
from app.core.llm_clients import complete
from app.core.stack_resolver import resolve_stack


router = APIRouter(
    tags=["synthesis"],
    dependencies=[Depends(require_api_key)],
)


class BackfillRequest(BaseModel):
    """Optional filters for which entities to backfill."""
    entity_ids: Optional[list[UUID]] = None
    only_missing: bool = True


class BackfillResult(BaseModel):
    stack_id: UUID
    entities_considered: int
    entities_synthesized: int
    entities_skipped: int


def _synthesize_one(
    conn,
    stack_id: UUID,
    entity_id: UUID,
    domain_context_names: list[str],
) -> bool:
    """
    Synthesize a description for a single entity. Returns True if a
    description was written, False if there was nothing to ground in.
    """
    with conn.cursor() as cur:
        cur.execute(
            "select name, type from ontology_entities where id = %s",
            (str(entity_id),),
        )
        ent = cur.fetchone()
        if not ent:
            return False

        # Find chunks that mention this entity by name
        cur.execute(
            """
            select dc.content
            from document_chunks dc
            join entity_source_documents esd
              on esd.document_id = dc.document_id
              and esd.entity_id = %s
            where dc.stack_id = %s
              and dc.content ilike %s
            order by length(dc.content) asc
            limit 3
            """,
            (str(entity_id), str(stack_id), f"%{ent['name']}%"),
        )
        chunks = [r["content"] for r in cur.fetchall()]

    if not chunks:
        return False

    chunk_text = "\n\n---\n\n".join(chunks)
    domain_context = ", ".join(sorted(domain_context_names))

    prompt = f"""You are writing a compiled description for one entity in a knowledge graph.

ENTITY: {ent['name']}
TYPE: {ent['type']}

OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):
{domain_context}

SOURCE PASSAGES THAT MENTION THIS ENTITY:
{chunk_text}

Write a description that is 2-4 sentences, reflects what the passages
say, references siblings naturally when relevant, and contains no
filler. Return ONLY the description as plain prose."""

    new_desc = complete(prompt, max_tokens=300)

    with conn.cursor() as cur:
        cur.execute(
            """
            update ontology_entities
            set description = %s,
                updated_at = now()
            where id = %s
            """,
            (new_desc, str(entity_id)),
        )
    return True


@router.post(
    "/stacks/{stack_id}/synthesize-descriptions",
    response_model=BackfillResult,
    summary="Backfill descriptions for entities in a Stack",
)
def backfill_stack(
    stack_id: UUID,
    payload: BackfillRequest,
    conn=Depends(get_db),
) -> BackfillResult:
    """
    Synthesize descriptions for entities in a Stack. By default, processes
    only entities whose description is empty or very short. Set
    only_missing=false to regenerate every entity. Pass entity_ids to
    limit the scope to a specific subset.

    Cost: roughly $0.01-0.02 per entity processed.
    """
    stack = resolve_stack(conn, stack_id=stack_id)

    sql = """
        select id, name, description
        from ontology_entities
        where stack_id = %s
    """
    params: list = [str(stack["id"])]

    if payload.entity_ids:
        sql += " and id = any(%s::uuid[])"
        params.append([str(eid) for eid in payload.entity_ids])

    if payload.only_missing:
        sql += " and (description is null or length(description) < 20)"

    with conn.cursor() as cur:
        cur.execute(sql, params)
        candidates = cur.fetchall()

        cur.execute(
            "select name from ontology_entities where stack_id = %s",
            (str(stack["id"]),),
        )
        all_names = [r["name"] for r in cur.fetchall()]

    synthesized = 0
    skipped = 0
    for c in candidates:
        wrote = _synthesize_one(conn, stack["id"], c["id"], all_names)
        if wrote:
            synthesized += 1
        else:
            skipped += 1

    return BackfillResult(
        stack_id=stack["id"],
        entities_considered=len(candidates),
        entities_synthesized=synthesized,
        entities_skipped=skipped,
    )


@router.post(
    "/aks/v1/entities/{name}/synthesize-description",
    summary="Synthesize a description for one entity",
)
def synthesize_one_entity(
    name: str,
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    conn=Depends(get_db),
) -> dict:
    """
    Synthesize the description for a single entity by name.
    """
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    with conn.cursor() as cur:
        cur.execute(
            """
            select id from ontology_entities
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

    with conn.cursor() as cur:
        cur.execute(
            "select name from ontology_entities where stack_id = %s",
            (str(stack["id"]),),
        )
        all_names = [r["name"] for r in cur.fetchall()]

    wrote = _synthesize_one(conn, stack["id"], row["id"], all_names)

    with conn.cursor() as cur:
        cur.execute(
            "select name, description from ontology_entities where id = %s",
            (str(row["id"]),),
        )
        result = cur.fetchone()

    return {
        "entity_name": result["name"],
        "description": result["description"],
        "synthesized": wrote,
    }
