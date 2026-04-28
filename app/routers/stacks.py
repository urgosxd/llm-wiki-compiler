"""
Stack CRUD endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID

from app.core.database import get_db
from app.core.auth import require_api_key
from app.models.api import StackCreate, StackUpdate, StackResponse


router = APIRouter(
    prefix="/stacks",
    tags=["stacks"],
    dependencies=[Depends(require_api_key)],
)


_STACK_COLUMNS = """
    id, name, domain, description, scope,
    compilation_strategy, synthesize_descriptions,
    created_at, updated_at
"""


@router.post(
    "",
    response_model=StackResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new Knowledge Stack",
)
def create_stack(
    payload: StackCreate,
    conn=Depends(get_db),
) -> StackResponse:
    """Create a Stack. Domain must be unique. Returns 409 on conflict."""
    with conn.cursor() as cur:
        cur.execute("select id from stacks where domain = %s", (payload.domain,))
        if cur.fetchone():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Stack with domain '{payload.domain}' already exists",
            )

        cur.execute(
            f"""
            insert into stacks (name, domain, description, scope,
                                compilation_strategy, synthesize_descriptions)
            values (%s, %s, %s, %s, %s, %s)
            returning {_STACK_COLUMNS}
            """,
            (
                payload.name,
                payload.domain,
                payload.description,
                payload.scope,
                payload.compilation_strategy,
                payload.synthesize_descriptions,
            ),
        )
        row = cur.fetchone()

    return StackResponse(**row)


@router.get(
    "",
    response_model=List[StackResponse],
    summary="List all Knowledge Stacks",
)
def list_stacks(conn=Depends(get_db)) -> List[StackResponse]:
    """List every Stack, most recently updated first."""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            select {_STACK_COLUMNS}
            from stacks
            order by updated_at desc
            """
        )
        rows = cur.fetchall()
    return [StackResponse(**row) for row in rows]


@router.get(
    "/{stack_id}",
    response_model=StackResponse,
    summary="Get a Stack by ID",
)
def get_stack(
    stack_id: UUID,
    conn=Depends(get_db),
) -> StackResponse:
    """Fetch a Stack by UUID. 404 if not found."""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            select {_STACK_COLUMNS}
            from stacks
            where id = %s
            """,
            (str(stack_id),),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Stack {stack_id} not found",
        )
    return StackResponse(**row)


@router.patch(
    "/{stack_id}",
    response_model=StackResponse,
    summary="Update fields on a Stack",
)
def update_stack(
    stack_id: UUID,
    payload: StackUpdate,
    conn=Depends(get_db),
) -> StackResponse:
    """Partial update. Only fields the client sends are modified."""
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one field must be provided",
        )

    set_clauses = [f"{key} = %s" for key in updates.keys()]
    set_clauses.append("updated_at = now()")
    values = list(updates.values()) + [str(stack_id)]

    with conn.cursor() as cur:
        cur.execute(
            f"""
            update stacks
            set {', '.join(set_clauses)}
            where id = %s
            returning {_STACK_COLUMNS}
            """,
            values,
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Stack {stack_id} not found",
        )
    return StackResponse(**row)


@router.delete(
    "/{stack_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a Stack",
)
def delete_stack(
    stack_id: UUID,
    conn=Depends(get_db),
) -> None:
    """Delete a Stack."""
    with conn.cursor() as cur:
        cur.execute(
            "delete from stacks where id = %s returning id",
            (str(stack_id),),
        )
        if not cur.fetchone():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Stack {stack_id} not found",
            )
