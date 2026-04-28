"""
Entity page endpoints.

  GET /aks/v1/pages/{entity_name}    one page on demand
  GET /aks/v1/pages                  all pages, returned as a zip

Pages are generated from the compiled graph and cached by graph_version.
First request to an entity costs one LLM call. Subsequent requests serve
from cache until the underlying graph changes.
"""

import io
import zipfile
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.core.auth import require_api_key
from app.core.database import get_db
from app.core.page_generator import get_or_generate_page
from app.core.stack_resolver import resolve_stack
from app.models.api import AKSEntityPage


router = APIRouter(
    prefix="/aks/v1/pages",
    tags=["entity-pages"],
    dependencies=[Depends(require_api_key)],
)


# ============================================================
# GET /aks/v1/pages/{entity_name}
# ============================================================

@router.get(
    "/{entity_name}",
    response_model=AKSEntityPage,
    summary="Get the markdown page for one entity",
)
def get_entity_page(
    entity_name: str,
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    conn=Depends(get_db),
) -> AKSEntityPage:
    """
    Generate or fetch a cached entity page.

    Slow on first call (one LLM call). Fast on subsequent calls until
    the underlying graph changes, at which point the next call regenerates.
    """
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    # Resolve the entity name within the Stack
    with conn.cursor() as cur:
        cur.execute(
            """
            select id from ontology_entities
            where stack_id = %s and lower(name) = lower(%s)
            """,
            (str(stack["id"]), entity_name),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Entity '{entity_name}' not found in Stack",
        )

    page = get_or_generate_page(conn, row["id"])
    if not page:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate entity page",
        )

    return AKSEntityPage(**page)


# ============================================================
# GET /aks/v1/pages
# ============================================================

@router.get(
    "",
    summary="Download all entity pages in the Stack as a zip archive",
)
def get_all_pages(
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    min_confidence: float = Query(0.0, ge=0.0, le=1.0),
    conn=Depends(get_db),
):
    """
    Generate (or fetch from cache) every entity page in the Stack and
    return them as a zip archive of markdown files.

    First call on a fresh Stack is slow — one LLM call per entity.
    Subsequent calls are fast except for entities whose graph has
    changed since the last generation.
    """
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    # Get all entity IDs in scope
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, name from ontology_entities
            where stack_id = %s and confidence >= %s
            order by name
            """,
            (str(stack["id"]), min_confidence),
        )
        entity_rows = cur.fetchall()

    if not entity_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Stack has no entities meeting the filter criteria",
        )

    # Build the zip in memory
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # README inside the archive describing the contents
        readme = (
            f"# {stack['name']} — Entity Pages\n\n"
            f"Generated from AKS Stack `{stack['domain']}` "
            f"on {datetime.now(timezone.utc).isoformat()}.\n\n"
            f"Total entities: {len(entity_rows)}\n\n"
            f"Each `.md` file is a wiki-style page for one entity, "
            f"generated from the compiled knowledge graph.\n"
        )
        zf.writestr("README.md", readme)

        for entity_row in entity_rows:
            page = get_or_generate_page(conn, entity_row["id"])
            if not page:
                continue
            # Sanitize the entity name into a safe filename
            safe_name = (
                page["entity_name"]
                .replace("/", "-")
                .replace("\\", "-")
                .replace(":", "-")
                .replace(" ", "_")
            )
            filename = f"{safe_name}.md"
            zf.writestr(filename, page["markdown"])

    buf.seek(0)
    archive_filename = f"{stack['domain']}-entity-pages.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename={archive_filename}"
        },
    )