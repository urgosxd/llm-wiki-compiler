"""
File handling utilities for uploaded documents.

Three concerns:
  1. Compute SHA-256 hash of uploaded content
  2. Write content to disk under a predictable path
  3. Detect when text content exceeds the extraction limit

None of these touch FastAPI, so they're trivially unit-testable.
"""
import hashlib
from pathlib import Path
from uuid import UUID

from app.core.constants import UPLOAD_DIR, MAX_EXTRACTION_CHARS


def compute_sha256(data: bytes) -> str:
    """Hex SHA-256 digest of bytes."""
    return hashlib.sha256(data).hexdigest()


def get_storage_path(stack_id: UUID, document_id: UUID, filename: str) -> str:
    """
    Build the relative storage path for an uploaded document.

    Format: uploads/{stack_id}/{document_id}{ext}

    Using document_id in the filename guarantees uniqueness even if two
    real files have the same name. The original filename is preserved
    in the database column.
    """
    ext = Path(filename).suffix  # includes the dot, e.g. ".pdf"
    return f"{UPLOAD_DIR}/{stack_id}/{document_id}{ext}"


def write_bytes_to_storage(data: bytes, storage_path: str) -> None:
    """
    Write bytes to disk at the given relative path.

    Creates parent directories as needed. Overwrites if the file exists
    (safe because document_id is unique per upload).
    """
    path = Path(storage_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def check_truncation(text_content: str) -> tuple[bool, int | None]:
    """
    Return (truncated, original_length).

    truncated=True means text exceeds the extraction limit and would be
    cut at extraction time. Group 3 actually does the cutting; this
    function just detects.
    """
    length = len(text_content)
    if length > MAX_EXTRACTION_CHARS:
        return True, length
    return False, None


def try_decode_as_text(data: bytes) -> str | None:
    """
    Try decoding bytes as UTF-8. Returns None for binary content.

    Used to decide whether truncation detection applies. Binary files
    (PDFs, images) get truncation-checked later, after format-specific
    text extraction in Group 3.
    """
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None