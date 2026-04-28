"""
Resolve a Stack from either a UUID or a domain slug.

Every AKS endpoint accepts both as alternatives — clients can call
?stack_id=<uuid> or ?domain=<slug>. This helper centralizes the lookup
and the 422-when-neither-is-provided behavior.
"""
from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status
from psycopg2.extensions import connection as PGConnection


def resolve_stack(
    conn: PGConnection,
    stack_id: Optional[UUID] = None,
    domain: Optional[str] = None,
) -> dict:
    """
    Look up a Stack by id or domain. Returns the full row as a dict.

    Returns 422 if neither parameter is provided (matches the AKS spec
    requirement). Returns 404 if the Stack doesn't exist.
    """
    if not stack_id and not domain:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Either stack_id (UUID) or domain (slug) must be provided",
        )

    with conn.cursor() as cur:
        if stack_id:
            cur.execute(
                """
                select id, name, domain, description, scope,
                       compilation_strategy, created_at, updated_at
                from stacks
                where id = %s
                """,
                (str(stack_id),),
            )
        else:
            cur.execute(
                """
                select id, name, domain, description, scope,
                       compilation_strategy, created_at, updated_at
                from stacks
                where domain = %s
                """,
                (domain,),
            )
        row = cur.fetchone()

    if not row:
        ident = stack_id if stack_id else domain
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Stack '{ident}' not found",
        )

    return dict(row)