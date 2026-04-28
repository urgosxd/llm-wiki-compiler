"""
Application configuration.

The reference server uses a provider-based configuration model:
the user picks WHAT they want (an embedding model, an extraction model)
and WHERE the traffic should go (openai, anthropic, or gateway). This
file resolves those choices into env-driven config; the actual SDK
client construction lives in app/core/llm_clients.py so that the rest
of the codebase doesn't have to know which provider is in use.
"""
import os
from typing import Literal
from dotenv import load_dotenv

load_dotenv()


# Type aliases for provider names. These are the only valid values.
EmbeddingProvider = Literal["openai", "gateway"]
ExtractionProvider = Literal["anthropic", "openai", "gateway"]


class Config:
    """Single source of truth for app configuration."""

    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://aks:aks@localhost:5432/aks",
    )

    # Optional API key for protecting the server. Empty string = open mode.
    AKS_API_KEY: str = os.getenv("AKS_API_KEY", "").strip()

    # ----------------------------------------------------------------
    # Embedding configuration
    # ----------------------------------------------------------------
    # Which model produces vector embeddings? Must match EMBEDDING_DIM
    # below — pgvector enforces dimension at the column level.
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    EMBEDDING_DIM: int = int(os.getenv("EMBEDDING_DIM", "1536"))

    # Where do embedding requests go?
    #   openai  -> api.openai.com using OPENAI_API_KEY
    #   gateway -> GATEWAY_URL using GATEWAY_API_KEY
    EMBEDDING_PROVIDER: EmbeddingProvider = os.getenv(
        "EMBEDDING_PROVIDER", "openai"
    ).lower()  # type: ignore

    # ----------------------------------------------------------------
    # Extraction / synthesis configuration
    # ----------------------------------------------------------------
    # Which model handles entity extraction, description synthesis,
    # context-query reasoning, and entity-page generation?
    EXTRACTION_MODEL: str = os.getenv("EXTRACTION_MODEL", "claude-sonnet-4-5")

    # Where do extraction requests go?
    #   anthropic -> api.anthropic.com using ANTHROPIC_API_KEY
    #   openai    -> api.openai.com using OPENAI_API_KEY (for GPT-class models)
    #   gateway   -> GATEWAY_URL using GATEWAY_API_KEY
    EXTRACTION_PROVIDER: ExtractionProvider = os.getenv(
        "EXTRACTION_PROVIDER", "anthropic"
    ).lower()  # type: ignore

    # ----------------------------------------------------------------
    # Provider credentials. Only set the ones your chosen providers use.
    # ----------------------------------------------------------------
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    GATEWAY_URL: str = os.getenv("GATEWAY_URL", "").strip()
    GATEWAY_API_KEY: str = os.getenv("GATEWAY_API_KEY", "")

    @property
    def auth_enabled(self) -> bool:
        return bool(self.AKS_API_KEY)

    def validate(self) -> None:
        """
        Validate that the chosen providers have the keys they need.
        Called at startup so misconfigurations fail fast with a clear
        message instead of failing on the first request.
        """
        if self.EMBEDDING_PROVIDER == "openai" and not self.OPENAI_API_KEY:
            raise ValueError(
                "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set"
            )
        if self.EMBEDDING_PROVIDER == "gateway" and (
            not self.GATEWAY_URL or not self.GATEWAY_API_KEY
        ):
            raise ValueError(
                "EMBEDDING_PROVIDER=gateway but GATEWAY_URL or "
                "GATEWAY_API_KEY is not set"
            )
        if self.EXTRACTION_PROVIDER == "anthropic" and not self.ANTHROPIC_API_KEY:
            raise ValueError(
                "EXTRACTION_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set"
            )
        if self.EXTRACTION_PROVIDER == "openai" and not self.OPENAI_API_KEY:
            raise ValueError(
                "EXTRACTION_PROVIDER=openai but OPENAI_API_KEY is not set"
            )
        if self.EXTRACTION_PROVIDER == "gateway" and (
            not self.GATEWAY_URL or not self.GATEWAY_API_KEY
        ):
            raise ValueError(
                "EXTRACTION_PROVIDER=gateway but GATEWAY_URL or "
                "GATEWAY_API_KEY is not set"
            )


config = Config()
