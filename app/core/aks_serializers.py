"""
Convert ontology rows from Postgres into the nested AKS response shapes
defined in app.models.api.

Database rows are flat. AKS entities have a nested source block plus a
contributing_documents array fetched from a join table. The functions
here handle the reshape.
"""
from typing import Iterable
from uuid import UUID

from psycopg2.extensions import connection as PGConnection

from app.models.api import AKSEntity, AKSRelationship, AKSSource


def row_to_entity(
    row: dict,
    contributing_documents: list[UUID],
) -> AKSEntity:
    """Build an AKSEntity from an ontology_entities row plus a doc list."""
    return AKSEntity(
        id=row["id"],
        name=row["name"],
        type=row["type"],
        description=row["description"],
        properties=row.get("properties") or {},
        confidence=float(row["confidence"]),
        contributing_documents=contributing_documents,
        last_seen_at=row.get("last_seen_at"),
        source=AKSSource(
            source_kind=row.get("source_kind"),
            extracted_at=row.get("extracted_at"),
            model=row.get("extracted_by_model"),
            verified=bool(row.get("verified", False)),
            pipeline=row.get("pipeline"),
        ),
    )


def row_to_relationship(row: dict) -> AKSRelationship:
    """Build an AKSRelationship from an ontology_relationships row."""
    return AKSRelationship(
        id=row["id"],
        from_entity_id=row["from_entity_id"],
        to_entity_id=row["to_entity_id"],
        type=row["type"],
        description=row.get("description"),
        confidence=float(row["confidence"]),
        source=AKSSource(
            source_kind=row.get("source_kind"),
            extracted_at=row.get("extracted_at"),
            model=row.get("extracted_by_model"),
            verified=bool(row.get("verified", False)),
            pipeline=row.get("pipeline"),
        ),
    )


def fetch_contributing_documents(
    conn: PGConnection,
    entity_ids: Iterable[UUID],
) -> dict[UUID, list[UUID]]:
    """
    Batch-fetch contributing_documents for a set of entity IDs.

    Returns a dict of entity_id -> list[document_id].

    Doing this once per request rather than per-entity avoids N+1 queries
    when listing entities.
    """
    ids_list = [str(eid) for eid in entity_ids]
    if not ids_list:
        return {}

    out: dict[UUID, list[UUID]] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            select entity_id, document_id
            from entity_source_documents
            where entity_id = any(%s::uuid[])
            order by contributed_at
            """,
            (ids_list,),
        )
        for row in cur.fetchall():
            out.setdefault(row["entity_id"], []).append(row["document_id"])

    return out