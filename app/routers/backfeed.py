"""
Backfeed endpoints — the human-review loop.

  POST /aks/v1/backfeed/flag       queue an item for review
  GET  /aks/v1/backfeed/queue      list pending items
  POST /aks/v1/backfeed/approve    absorb an approved item
  POST /aks/v1/backfeed/reject     mark an item rejected
  GET  /aks/v1/backfeed/{item_id}  fetch a single item

Backfeed is the writeback path for compiled knowledge. It does not
call the LLM. Reasoning happened before the item arrived; the Stack
just absorbs the result after human approval.
"""

import json
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.auth import require_api_key
from app.core.consolidation import consolidate_backfeed_proposal
from app.core.database import get_db
from app.core.stack_resolver import resolve_stack
from app.models.api import (
    BackfeedApprovalRequest,
    BackfeedApprovalResult,
    BackfeedFlagRequest,
    BackfeedItemResponse,
    BackfeedProposal,
    BackfeedRejectionRequest,
)


router = APIRouter(
    prefix="/aks/v1/backfeed",
    tags=["backfeed"],
    dependencies=[Depends(require_api_key)],
)


def _row_to_item(row: dict) -> BackfeedItemResponse:
    """Reshape a backfeed_queue row into the API response model."""
    proposal_data = row["proposal"]
    if isinstance(proposal_data, str):
        proposal_data = json.loads(proposal_data)
    return BackfeedItemResponse(
        id=row["id"],
        stack_id=row["stack_id"],
        origin=row["origin"],
        trigger_type=row["trigger_type"],
        proposal=BackfeedProposal(**proposal_data),
        note=row.get("note"),
        metadata=row.get("metadata") or {},
        status=row["status"],
        reviewed_at=row.get("reviewed_at"),
        reviewed_by=row.get("reviewed_by"),
        review_note=row.get("review_note"),
        created_at=row["created_at"],
    )


# ============================================================
# POST /aks/v1/backfeed/flag
# ============================================================

@router.post(
    "/flag",
    response_model=BackfeedItemResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Queue a proposed change for human review",
)
def flag_item(
    payload: BackfeedFlagRequest,
    conn=Depends(get_db),
) -> BackfeedItemResponse:
    """
    Submit a proposed change to a Stack for human review.

    The proposal can contain entities and/or relationships. Nothing
    is added to the ontology yet — the item lives in pending status
    until approved.
    """
    if not payload.proposal.entities and not payload.proposal.relationships:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Proposal must include at least one entity or relationship",
        )

    stack = resolve_stack(conn, stack_id=payload.stack_id, domain=payload.domain)

    proposal_json = json.dumps(payload.proposal.model_dump())

    with conn.cursor() as cur:
        cur.execute(
            """
            insert into backfeed_queue (
                stack_id, origin, trigger_type, proposal,
                note, metadata, status
            )
            values (%s, %s, %s, %s, %s, %s, 'pending')
            returning id, stack_id, origin, trigger_type, proposal,
                      note, metadata, status, reviewed_at, reviewed_by,
                      review_note, created_at
            """,
            (
                str(stack["id"]),
                payload.origin,
                payload.trigger_type,
                proposal_json,
                payload.note,
                json.dumps(payload.metadata),
            ),
        )
        row = cur.fetchone()

    return _row_to_item(row)


# ============================================================
# GET /aks/v1/backfeed/queue
# ============================================================

@router.get(
    "/queue",
    response_model=list[BackfeedItemResponse],
    summary="List backfeed queue items",
)
def list_queue(
    stack_id: Optional[UUID] = Query(None),
    domain: Optional[str] = Query(None),
    item_status: Optional[str] = Query(
        "pending",
        description="Filter by status: pending, approved, rejected. Pass 'all' for everything.",
    ),
    limit: int = Query(50, ge=1, le=200),
    conn=Depends(get_db),
) -> list[BackfeedItemResponse]:
    """List queue items for a Stack, defaulting to pending only."""
    stack = resolve_stack(conn, stack_id=stack_id, domain=domain)

    sql = """
        select id, stack_id, origin, trigger_type, proposal,
               note, metadata, status, reviewed_at, reviewed_by,
               review_note, created_at
        from backfeed_queue
        where stack_id = %s
    """
    params: list = [str(stack["id"])]

    if item_status and item_status != "all":
        if item_status not in ("pending", "approved", "rejected"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="status must be pending, approved, rejected, or all",
            )
        sql += " and status = %s"
        params.append(item_status)

    sql += " order by created_at desc limit %s"
    params.append(limit)

    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return [_row_to_item(r) for r in rows]


# ============================================================
# GET /aks/v1/backfeed/{item_id}
# ============================================================

@router.get(
    "/{item_id}",
    response_model=BackfeedItemResponse,
    summary="Fetch a single backfeed item",
)
def get_item(
    item_id: UUID,
    conn=Depends(get_db),
) -> BackfeedItemResponse:
    """Fetch a single item by ID."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, stack_id, origin, trigger_type, proposal,
                   note, metadata, status, reviewed_at, reviewed_by,
                   review_note, created_at
            from backfeed_queue
            where id = %s
            """,
            (str(item_id),),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Backfeed item {item_id} not found",
        )

    return _row_to_item(row)


# ============================================================
# POST /aks/v1/backfeed/approve
# ============================================================

@router.post(
    "/approve",
    response_model=BackfeedApprovalResult,
    summary="Approve a backfeed item and absorb its proposal",
)
def approve_item(
    payload: BackfeedApprovalRequest,
    conn=Depends(get_db),
) -> BackfeedApprovalResult:
    """
    Approve a pending backfeed item.

    Absorbs the proposal into the ontology via the consolidation logic,
    marking all resulting entities and relationships as verified=true
    and source_kind='backfeed'.

    Idempotent: re-approving an already-approved item returns the
    same result without modifying the ontology again.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, stack_id, status, proposal
            from backfeed_queue
            where id = %s
            """,
            (str(payload.item_id),),
        )
        item = cur.fetchone()

    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Backfeed item {payload.item_id} not found",
        )

    if item["status"] == "rejected":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot approve an item that has been rejected",
        )

    if item["status"] == "approved":
        # Idempotent path. Don't re-absorb.
        return BackfeedApprovalResult(
            item_id=payload.item_id,
            entities_absorbed=0,
            relationships_absorbed=0,
            status="approved",
        )

    proposal = item["proposal"]
    if isinstance(proposal, str):
        proposal = json.loads(proposal)

    # Absorb into the ontology
    entities_absorbed, relationships_absorbed = consolidate_backfeed_proposal(
        conn=conn,
        stack_id=item["stack_id"],
        entities=proposal.get("entities", []),
        relationships=proposal.get("relationships", []),
    )

    # Mark the queue item as approved
    with conn.cursor() as cur:
        cur.execute(
            """
            update backfeed_queue
            set status = 'approved',
                reviewed_at = now(),
                reviewed_by = %s,
                review_note = %s
            where id = %s
            """,
            (payload.reviewed_by, payload.review_note, str(payload.item_id)),
        )

    return BackfeedApprovalResult(
        item_id=payload.item_id,
        entities_absorbed=entities_absorbed,
        relationships_absorbed=relationships_absorbed,
        status="approved",
    )


# ============================================================
# POST /aks/v1/backfeed/reject
# ============================================================

@router.post(
    "/reject",
    response_model=BackfeedItemResponse,
    summary="Reject a backfeed item without absorbing it",
)
def reject_item(
    payload: BackfeedRejectionRequest,
    conn=Depends(get_db),
) -> BackfeedItemResponse:
    """Mark a backfeed item as rejected. Nothing is added to the ontology."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update backfeed_queue
            set status = 'rejected',
                reviewed_at = now(),
                reviewed_by = %s,
                review_note = %s
            where id = %s
              and status = 'pending'
            returning id, stack_id, origin, trigger_type, proposal,
                      note, metadata, status, reviewed_at, reviewed_by,
                      review_note, created_at
            """,
            (payload.reviewed_by, payload.review_note, str(payload.item_id)),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Backfeed item {payload.item_id} not found or "
                "not in pending status"
            ),
        )

    return _row_to_item(row)