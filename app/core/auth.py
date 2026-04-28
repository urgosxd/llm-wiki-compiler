"""
Optional API key authentication.

When AKS_API_KEY is set, clients must send the value in an X-API-Key header.
When it's blank, the server runs in pass-through mode (every request is
allowed). This is intentional for the reference implementation: production
deployments set a key; local development doesn't have to.
"""
from fastapi import Header, HTTPException, status
from typing import Annotated

from app.core.config import config


async def require_api_key(
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    """
    FastAPI dependency that enforces the API key.

    The parameter name `x_api_key` plus FastAPI's Header() declaration tells
    FastAPI to read the X-API-Key header from the request. Header names are
    case-insensitive and FastAPI converts kebab-case to snake_case automatically.
    """
    if not config.auth_enabled:
        return  # Pass-through mode — server is open

    if x_api_key != config.AKS_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key. Provide it in the X-API-Key header.",
        )