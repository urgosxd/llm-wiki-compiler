"""
FastAPI application entry point.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import config
from app.routers import stacks, documents, ingest, aks, pages, synthesize, backfeed


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager. Runs startup logic before the server
    accepts requests, then yields control. Replaces the deprecated
    @app.on_event("startup") decorator.
    """
    # Validate provider configuration; fail fast on misconfiguration
    config.validate()

    # Use print() so the message always shows regardless of logging level
    print(
        f"[AKS] Inference: extraction via {config.EXTRACTION_PROVIDER} "
        f"({config.EXTRACTION_MODEL}), "
        f"embeddings via {config.EMBEDDING_PROVIDER} "
        f"({config.EMBEDDING_MODEL})",
        flush=True,
    )
    if config.EMBEDDING_PROVIDER == "gateway" or config.EXTRACTION_PROVIDER == "gateway":
        print(f"[AKS] Gateway URL: {config.GATEWAY_URL}", flush=True)

    yield  # Server runs while we're inside this context


app = FastAPI(
    title="AKS Reference Server",
    description="Reference implementation of the Agent Knowledge Standard (AKS)",
    version="0.2.0",
    lifespan=lifespan,
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
def health() -> dict:
    """Health check. Does not require auth."""
    return {"status": "ok", "service": "aks-reference-server", "version": "0.2.0"}


# Routers
app.include_router(stacks.router)
app.include_router(documents.router)
app.include_router(ingest.router)
app.include_router(aks.router)
app.include_router(pages.router)
app.include_router(synthesize.router)
app.include_router(backfeed.router)
