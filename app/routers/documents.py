"""
Document upload and retrieval.

Endpoints:
  POST   /stacks/{stack_id}/documents    upload a file
  GET    /stacks/{stack_id}/documents    list documents in a Stack
  GET    /documents/{doc_id}             fetch a document record
  DELETE /documents/{doc_id}             delete a document

No LLM processing happens here. Compilation lives in Group 3.
"""
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pathlib import Path
from typing import List
from uuid import UUID, uuid4

from app.core.database import get_db
from app.core.auth import require_api_key
from app.core.constants import MAX_UPLOAD_BYTES
from app.core.files import (
    compute_sha256,
    get_storage_path,
    write_bytes_to_storage,
    check_truncation,
    try_decode_as_text,
)
from app.models.api import DocumentResponse


router = APIRouter(
    tags=["documents"],
    dependencies=[Depends(require_api_key)],
)


# ============================================================
# POST /stacks/{stack_id}/documents
# ============================================================
@router.post(
    "/stacks/{stack_id}/documents",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a document to a Stack",
)
async def upload_document(
    stack_id: UUID,
    file: UploadFile = File(...),
    conn=Depends(get_db),
) -> DocumentResponse:
    """
    Upload a file to a Stack.

    Pipeline:
      1. Verify Stack exists (early 404 on bad stack_id)
      2. Read the upload (capped at MAX_UPLOAD_BYTES)
      3. Hash the content. If this hash exists in this Stack, return the
         existing record without re-storing — uploads are idempotent by content.
      4. Write the file to disk
      5. Detect truncation for text-decodable files
      6. Insert the document record and return it
    """
    # Verify the Stack exists. Doing this first means we don't waste time
    # reading a 50MB upload only to 404 because the stack_id was bogus.
    with conn.cursor() as cur:
        cur.execute("select id from stacks where id = %s", (str(stack_id),))
        if not cur.fetchone():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Stack {stack_id} not found",
            )

    # Read the upload. UploadFile.read() with no argument reads to end.
    # Production systems would stream this for large files; the reference
    # server takes the simpler path.
    data = await file.read()

    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_UPLOAD_BYTES} byte limit",
        )

    if len(data) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty",
        )

    source_hash = compute_sha256(data)

    # Idempotency check. Same content already in this Stack? Return that record.
    # This means a user re-uploading the same file gets the same UUID back
    # rather than creating duplicate database rows or re-running ingestion.
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, stack_id, filename, size_bytes, content_type,
                   source_hash, truncated, original_length, ingested_at, audit
            from stack_documents
            where stack_id = %s and source_hash = %s
            """,
            (str(stack_id), source_hash),
        )
        existing = cur.fetchone()
        if existing:
            return DocumentResponse(**existing)

    # Generate the document_id up front so the storage path is deterministic.
    document_id = uuid4()
    filename = file.filename or "unknown"
    storage_path = get_storage_path(stack_id, document_id, filename)

    write_bytes_to_storage(data, storage_path)

    # Truncation detection for text. Binary files (PDFs, images) skip this
    # and will get truncation-checked in Group 3 after text extraction.
    text = try_decode_as_text(data)
    if text is not None:
        truncated, original_length = check_truncation(text)
    else:
        truncated, original_length = False, None

    # Insert the document record.
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into stack_documents (
                id, stack_id, filename, storage_path, size_bytes,
                content_type, source_hash, truncated, original_length
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning id, stack_id, filename, size_bytes, content_type,
                      source_hash, truncated, original_length,
                      ingested_at, audit
            """,
            (
                str(document_id),
                str(stack_id),
                filename,
                storage_path,
                len(data),
                file.content_type,
                source_hash,
                truncated,
                original_length,
            ),
        )
        row = cur.fetchone()

    return DocumentResponse(**row)


# ============================================================
# GET /stacks/{stack_id}/documents
# ============================================================
@router.get(
    "/stacks/{stack_id}/documents",
    response_model=List[DocumentResponse],
    summary="List documents in a Stack",
)
def list_documents(
    stack_id: UUID,
    conn=Depends(get_db),
) -> List[DocumentResponse]:
    """List all documents in a Stack, most recent first."""
    with conn.cursor() as cur:
        cur.execute("select id from stacks where id = %s", (str(stack_id),))
        if not cur.fetchone():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Stack {stack_id} not found",
            )

        cur.execute(
            """
            select id, stack_id, filename, size_bytes, content_type,
                   source_hash, truncated, original_length,
                   ingested_at, audit
            from stack_documents
            where stack_id = %s
            order by ingested_at desc
            """,
            (str(stack_id),),
        )
        rows = cur.fetchall()

    return [DocumentResponse(**row) for row in rows]


# ============================================================
# GET /documents/{doc_id}
# ============================================================
@router.get(
    "/documents/{doc_id}",
    response_model=DocumentResponse,
    summary="Get a document record by ID",
)
def get_document(
    doc_id: UUID,
    conn=Depends(get_db),
) -> DocumentResponse:
    """Fetch a document record. Does not return file contents."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, stack_id, filename, size_bytes, content_type,
                   source_hash, truncated, original_length,
                   ingested_at, audit
            from stack_documents
            where id = %s
            """,
            (str(doc_id),),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document {doc_id} not found",
        )
    return DocumentResponse(**row)


# ============================================================
# DELETE /documents/{doc_id}
# ============================================================
@router.delete(
    "/documents/{doc_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a document and its stored file",
)
def delete_document(
    doc_id: UUID,
    conn=Depends(get_db),
) -> None:
    """
    Delete the document record and its file on disk.

    In Group 3+ this will cascade through chunks and dereference from
    contributing_documents. For Group 2 it's just a row delete plus
    file removal.
    """
    with conn.cursor() as cur:
        cur.execute(
            "delete from stack_documents where id = %s returning storage_path",
            (str(doc_id),),
        )
        row = cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document {doc_id} not found",
        )

    # Remove the file. Silent if it's already gone.
    storage_path = Path(row["storage_path"])
    if storage_path.exists():
        storage_path.unlink()