"""
Consolidation: merging newly extracted entities and relationships into
the existing ontology of a Stack.

Extraction (in extraction.py) is stateless — it doesn't know what's in
the Stack. Consolidation is the piece that actually grows the ontology.
The algorithm is intentionally simple:

    for each newly extracted entity:
        if an entity with this name already exists in the Stack:
            consolidate: bump confidence, update last_seen_at,
                         keep the better description, record that this
                         document contributed to the entity
        else:
            insert as a new entity, record the contributing document

    for each newly extracted relationship:
        resolve from_name and to_name to entity UUIDs
        if the edge already exists:
            update confidence/description if the new extraction is stronger
        else:
            insert a new relationship

Consolidation is deterministic and does NOT call a LLM. Running this
across hundreds of newly extracted entities is sub-second. Idk, at least according to Claude... 

More sophisticated strategies (fuzzy name matching, contradiction
detection, description re-synthesis across all sources) can be added
later without changing the public function signatures.
"""

from __future__ import annotations

from typing import Sequence
from uuid import UUID

from psycopg2.extensions import connection as PGConnection

from app.core.config import config
from app.core.extraction import ExtractedEntity, ExtractedRelationship


# ============================================================================
# ENTITIES
# ============================================================================

def consolidate_entities(
    conn: PGConnection,
    stack_id: UUID,
    document_id: UUID,
    extracted: Sequence[ExtractedEntity],
) -> dict[str, UUID]:
    """
    Insert or update entities in the ontology.

    Returns a mapping from lowercased entity name → entity UUID. This map
    is consumed by consolidate_relationships immediately afterwards to
    resolve from_name/to_name string references into real UUIDs.
    """
    name_to_id: dict[str, UUID] = {}

    with conn.cursor() as cur:
        for ent in extracted:
            # Look up existing by (stack_id, name). Name uniqueness is
            # enforced at the schema level, so this is O(1) via index.
            cur.execute(
                """
                select id, confidence, description
                from ontology_entities
                where stack_id = %s and lower(name) = lower(%s)
                """,
                (str(stack_id), ent.name),
            )
            row = cur.fetchone()

            if row:
                # Consolidation path. Bump confidence toward 1.0 as more
                # sources corroborate. Keep the longer/better description.
                existing_id = row["id"]
                existing_conf = float(row["confidence"])
                existing_desc = row["description"] or ""

                new_conf = min(1.0, existing_conf + 0.05)

                # Description update rule: take the new one only if it's
                # meaningfully longer. Group 5 will replace this with
                # synthesized descriptions written from the compiled graph.
                if ent.description and len(ent.description) > len(existing_desc):
                    new_desc = ent.description
                else:
                    new_desc = existing_desc

                cur.execute(
                    """
                    update ontology_entities
                    set confidence = %s,
                        description = %s,
                        last_seen_at = now(),
                        updated_at = now()
                    where id = %s
                    """,
                    (new_conf, new_desc, existing_id),
                )
                name_to_id[ent.name.lower()] = existing_id

            else:
                # Fresh entity insert.
                cur.execute(
                    """
                    insert into ontology_entities (
                        stack_id, name, type, description, confidence,
                        extracted_by_model, source_kind, pipeline
                    )
                    values (%s, %s, %s, %s, %s, %s, %s, %s)
                    returning id
                    """,
                    (
                        str(stack_id),
                        ent.name,
                        ent.type,
                        ent.description,
                        ent.confidence,
                        config.EXTRACTION_MODEL,
                        "document",
                        "llamaindex-schema-extraction",
                    ),
                )
                new_id = cur.fetchone()["id"]
                name_to_id[ent.name.lower()] = new_id

            # Record the contributing document. ON CONFLICT DO NOTHING
            # keeps this idempotent on re-ingestion.
            cur.execute(
                """
                insert into entity_source_documents (entity_id, document_id, stack_id)
                values (%s, %s, %s)
                on conflict (entity_id, document_id) do nothing
                """,
                (
                    str(name_to_id[ent.name.lower()]),
                    str(document_id),
                    str(stack_id),
                ),
            )

    return name_to_id


# ============================================================================
# RELATIONSHIPS
# ============================================================================

def consolidate_relationships(
    conn: PGConnection,
    stack_id: UUID,
    extracted: Sequence[ExtractedRelationship],
    name_to_id: dict[str, UUID],
) -> int:
    """
    Insert or update relationships. Skips relationships where either endpoint
    couldn't be resolved (extraction occasionally references entities that
    weren't extracted as top-level — rare, but happens with permissive schemas).

    Returns the count of relationships actually written or updated.
    """
    written = 0

    with conn.cursor() as cur:
        for rel in extracted:
            from_id = name_to_id.get(rel.from_entity_name.lower())
            to_id = name_to_id.get(rel.to_entity_name.lower())

            if not from_id or not to_id:
                # Skip rather than invent an entity for an unresolved name.
                continue

            # UPSERT pattern. The unique constraint on
            # (stack_id, from_entity_id, to_entity_id, type) makes the
            # ON CONFLICT clause work atomically. Re-extracting the same
            # edge bumps confidence (taking the max) and updates the
            # description only when the new extraction is more confident.
            cur.execute(
                """
                insert into ontology_relationships (
                    stack_id, from_entity_id, to_entity_id, type,
                    description, confidence, extracted_by_model,
                    source_kind, pipeline
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (stack_id, from_entity_id, to_entity_id, type)
                do update set
                    confidence = greatest(
                        ontology_relationships.confidence,
                        excluded.confidence
                    ),
                    description = case
                        when excluded.confidence > ontology_relationships.confidence
                        then excluded.description
                        else ontology_relationships.description
                    end
                """,
                (
                    str(stack_id),
                    str(from_id),
                    str(to_id),
                    rel.type,
                    rel.description,
                    rel.confidence,
                    config.EXTRACTION_MODEL,
                    "document",
                    "llamaindex-schema-extraction",
                ),
            )
            written += 1

    return written

def consolidate_backfeed_proposal(
    conn: PGConnection,
    stack_id: UUID,
    entities: list[dict],
    relationships: list[dict],
) -> tuple[int, int]:
    """
    Absorb a backfeed proposal into the ontology.

    The same consolidation logic as document ingestion, but every
    inserted entity and relationship is tagged with:
      - source_kind = 'backfeed'
      - verified = true

    The verified=true is the key difference: backfeed items have been
    reviewed by a human, which is what makes them eligible for scope
    graduation per the AKS spec.

    Returns (entities_absorbed, relationships_absorbed).
    """
    name_to_id: dict[str, UUID] = {}
    entities_absorbed = 0
    relationships_absorbed = 0

    with conn.cursor() as cur:
        for ent in entities:
            cur.execute(
                """
                select id, confidence, description
                from ontology_entities
                where stack_id = %s and lower(name) = lower(%s)
                """,
                (str(stack_id), ent["name"]),
            )
            row = cur.fetchone()

            if row:
                # Existing entity: bump confidence, mark verified, update last_seen_at.
                existing_id = row["id"]
                existing_conf = float(row["confidence"])
                existing_desc = row["description"] or ""

                new_conf = min(1.0, existing_conf + 0.1)  # bigger bump than doc-extraction

                if ent.get("description") and len(ent["description"]) > len(existing_desc):
                    new_desc = ent["description"]
                else:
                    new_desc = existing_desc

                cur.execute(
                    """
                    update ontology_entities
                    set confidence = %s,
                        description = %s,
                        verified = true,
                        last_seen_at = now(),
                        updated_at = now()
                    where id = %s
                    """,
                    (new_conf, new_desc, existing_id),
                )
                name_to_id[ent["name"].lower()] = existing_id

            else:
                # Fresh entity from backfeed.
                cur.execute(
                    """
                    insert into ontology_entities (
                        stack_id, name, type, description, confidence,
                        verified, source_kind, pipeline
                    )
                    values (%s, %s, %s, %s, %s, true, 'backfeed', 'human-review')
                    returning id
                    """,
                    (
                        str(stack_id),
                        ent["name"],
                        ent["type"],
                        ent.get("description", ""),
                        ent.get("confidence", 0.7),
                    ),
                )
                new_id = cur.fetchone()["id"]
                name_to_id[ent["name"].lower()] = new_id

            entities_absorbed += 1

        # Now the relationships. Both endpoints must resolve to a name we
        # processed in this proposal, OR an entity that already exists in
        # the Stack.
        for rel in relationships:
            from_id = name_to_id.get(rel["from_entity"].lower())
            to_id = name_to_id.get(rel["to_entity"].lower())

            # If endpoints weren't in the proposal's entities, look them up.
            if not from_id:
                cur.execute(
                    "select id from ontology_entities where stack_id = %s and lower(name) = lower(%s)",
                    (str(stack_id), rel["from_entity"]),
                )
                row = cur.fetchone()
                if row:
                    from_id = row["id"]

            if not to_id:
                cur.execute(
                    "select id from ontology_entities where stack_id = %s and lower(name) = lower(%s)",
                    (str(stack_id), rel["to_entity"]),
                )
                row = cur.fetchone()
                if row:
                    to_id = row["id"]

            if not from_id or not to_id:
                # Skip relationships whose endpoints can't be resolved.
                continue

            cur.execute(
                """
                insert into ontology_relationships (
                    stack_id, from_entity_id, to_entity_id, type,
                    description, confidence, verified,
                    source_kind, pipeline
                )
                values (%s, %s, %s, %s, %s, %s, true, 'backfeed', 'human-review')
                on conflict (stack_id, from_entity_id, to_entity_id, type)
                do update set
                    confidence = greatest(
                        ontology_relationships.confidence,
                        excluded.confidence
                    ),
                    verified = true,
                    description = case
                        when excluded.confidence > ontology_relationships.confidence
                        then excluded.description
                        else ontology_relationships.description
                    end
                """,
                (
                    str(stack_id),
                    str(from_id),
                    str(to_id),
                    rel["type"],
                    rel.get("description", ""),
                    rel.get("confidence", 0.7),
                ),
            )
            relationships_absorbed += 1

    return entities_absorbed, relationships_absorbed